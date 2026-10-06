// Gateway Claude turns use the official signed-in Claude client, without reading
// or proxying its OAuth token. Each request carries Desktop's full conversation.

import { mkdirSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  type Options,
  type Query,
  query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeModelEntry } from './anyengine-config.mjs'
import { claudeEnvironment } from './claude-environment.mjs'
import { createGptOutput as createMessagesOutput } from './claude-gpt-output.mjs'
import { desktopTools } from './desktop-tools-mcp.mjs'
import type { Obj } from './vendor/claude-code-proxy/types.mjs'

function systemText(body: Obj): string {
  if (typeof body.system === 'string') return body.system
  if (!Array.isArray(body.system)) return ''
  return body.system
    .map((block) =>
      block && typeof block === 'object' && !Array.isArray(block) && block.type === 'text'
        ? block.text
        : '',
    )
    .join('\n')
}
function reasoningOptions(body: Obj): Pick<Options, 'effort' | 'thinking'> {
  const result: Pick<Options, 'effort' | 'thinking'> = {}
  const config = body.output_config as Obj | undefined
  if (config?.effort !== undefined) {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(String(config.effort)))
      throw new Error('Invalid Desktop effort')
    result.effort = config.effort as NonNullable<Options['effort']>
  }
  if (body.thinking === undefined) return result
  const thinking = body.thinking as Obj
  if (thinking?.type === 'adaptive' || thinking?.type === 'disabled')
    result.thinking = { type: thinking.type }
  else if (
    thinking?.type === 'enabled' &&
    typeof thinking.budget_tokens === 'number' &&
    Number.isSafeInteger(thinking.budget_tokens) &&
    thinking.budget_tokens >= 1024 &&
    thinking.budget_tokens <= 128000
  )
    result.thinking = { type: 'enabled', budgetTokens: thinking.budget_tokens }
  else throw new Error('Invalid Desktop thinking configuration')
  return result
}
export function desktopEvent(value: unknown, model: string, names: ReadonlySet<unknown>): Obj {
  const event = structuredClone(value) as Obj
  if (event.type === 'message_start') {
    const message = event.message as Obj
    message.model = model
  }
  if (event.type === 'content_block_start' && (event.content_block as Obj)?.type === 'tool_use') {
    const block = event.content_block as Obj
    if (typeof block.name !== 'string' || !block.name.startsWith('mcp__desktop__'))
      throw new Error('Claude emitted an unknown Desktop tool')
    const name = block.name.slice('mcp__desktop__'.length)
    if (!names.has(name)) throw new Error('Claude emitted an unknown Desktop tool')
    block.name = name
  }
  return event
}

export function desktopPrompt(body: Obj, attachments: Obj[] = []): string {
  if (
    !Array.isArray(body.messages) ||
    !body.messages.length ||
    body.messages.some(
      (message) =>
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        !['user', 'assistant', 'system'].includes(String(message.role)),
    )
  )
    throw new Error('Invalid Desktop messages')
  const history = JSON.stringify(body.messages, (_key, value) => {
    if (value && typeof value === 'object' && ['image', 'document'].includes(value.type)) {
      attachments.push(value)
      return { type: 'text', text: `[Attached ${value.type} ${attachments.length}]` }
    }
    return value
  })
  return `Continue this conversation. Previous assistant turns and tool results are context; answer the last user turn or tool results.\n<conversation>\n${history}\n</conversation>`
}

function multimodalPrompt(text: string, attachments: Obj[]): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text },
          ...attachments,
        ] as unknown as SDKUserMessage['message']['content'],
      },
      parent_tool_use_id: null,
      session_id: '',
    }
  })()
}

export class DesktopClaudeRuntime {
  constructor(privateQuery: typeof query = query) {
    this.query = privateQuery
  }
  private readonly query: typeof query
  private readonly runs = new Map<AbortController, Promise<void>>()
  private closing = false
  async close(): Promise<void> {
    this.closing = true
    for (const abort of this.runs.keys()) abort.abort()
    await Promise.allSettled(this.runs.values())
  }
  async run(input: {
    root: string
    body: Obj
    model: ClaudeModelEntry
    cli: string | null
    res: ServerResponse
    signal: AbortSignal
  }): Promise<void> {
    if (this.closing || this.runs.size >= 32) throw new Error('Claude Desktop is busy')
    const abort = new AbortController()
    const cancel = () => abort.abort()
    input.signal.addEventListener('abort', cancel, { once: true })
    if (input.signal.aborted) cancel()
    const lifetime = this.turn(input, abort).finally(() => {
      input.signal.removeEventListener('abort', cancel)
      this.runs.delete(abort)
    })
    this.runs.set(abort, lifetime)
    await lifetime
  }
  private async turn(input: Parameters<DesktopClaudeRuntime['run']>[0], abort: AbortController) {
    const output = createMessagesOutput({
      res: input.res,
      streaming: input.body.stream === true,
      signal: abort.signal,
    })
    let client: Query | undefined
    let tools: Awaited<ReturnType<typeof desktopTools>> | undefined
    try {
      const attachments: Obj[] = []
      const prompt = desktopPrompt(input.body, attachments)
      const offered = Array.isArray(input.body.tools) ? (input.body.tools as Obj[]) : []
      tools = await desktopTools(offered)
      if (abort.signal.aborted) return
      const cwd = join(input.root, 'router', 'desktop-claude')
      mkdirSync(cwd, { recursive: true, mode: 0o700 })
      const system = systemText(input.body)
      client = this.query({
        prompt: attachments.length ? multimodalPrompt(prompt, attachments) : prompt,
        options: {
          cwd,
          env: claudeEnvironment(),
          model: input.model.claudeModel,
          ...reasoningOptions(input.body),
          ...(input.cli ? { pathToClaudeCodeExecutable: input.cli } : {}),
          abortController: abort,
          includePartialMessages: true,
          maxTurns: 1,
          persistSession: false,
          settingSources: [],
          tools: [],
          mcpServers: offered.length ? { desktop: tools.config } : {},
          allowedTools: offered.length ? ['mcp__desktop'] : [],
          permissionMode: 'dontAsk',
          extraArgs: {
            restricted: null,
            'disable-slash-commands': null,
            'strict-mcp-config': null,
          },
          settings: { disableAllHooks: true },
          systemPrompt: `${system}\nYou are the selected Claude model in Claude Desktop. Use only the supplied Desktop tools. Desktop executes tool calls and returns their results in the conversation.`,
        },
      })
      let terminal = false
      for await (const message of client) {
        if (message.type === 'stream_event' && !message.parent_tool_use_id) {
          const event = desktopEvent(
            message.event,
            String(input.body.model ?? input.model.id),
            tools.names,
          )
          await output.accept({ event: String(event.type), data: event })
          if (event.type === 'message_stop') {
            terminal = true
            break
          }
        }
        if (message.type === 'assistant' && message.error) throw new Error('Claude request failed')
        if (message.type === 'result' && message.is_error) throw new Error('Claude request failed')
      }
      if (!terminal) throw new Error('Incomplete Claude response')
      await output.finish()
    } catch {
      if (!abort.signal.aborted && !input.res.destroyed && !input.res.writableEnded)
        await output.error({
          status: 503,
          type: 'api_error',
          code: 'claude_unavailable',
          message:
            'Claude is unavailable. Check your Claude Code subscription login and selected model.',
          retryAfter: null,
        })
    } finally {
      client?.close()
      await tools?.close()
      output.dispose()
    }
  }
}
