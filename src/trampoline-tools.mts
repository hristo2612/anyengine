// Ported from EthanSK/claude-in-codex (MIT) src/codexTools.js @ e2adced; see THIRD_PARTY_NOTICES.md.
// Changes: collision-safe aliases, bounded private sockets, scoped continuation registry.
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import net, { type Socket } from 'node:net'
import { join } from 'node:path'
import { anyengineRoot } from './anyengine-config.mjs'
import { onLines, writeLine } from './claim-protocol.mjs'
import { classifyUserText } from './codex-input.mjs'
import { type ResponsesStream, rid } from './responses-stream.mjs'
import { socketPathLimit } from './util.mjs'

export interface CodexToolEntry {
  name: string
  namespace?: string
  custom: boolean
  mcpTool: { name: string; description: string; inputSchema: unknown }
}
export interface PendingCodexCall {
  callId: string
  toolUseId: string | null
  entry: CodexToolEntry
  args: Record<string, unknown>
  resolve(output: unknown, userText?: string): void
}
export function isCodexToolName(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith('mcp__codex__')
}
function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
export function codexToolCatalog(tools: unknown): Map<string, CodexToolEntry> {
  const catalog = new Map<string, CodexToolEntry>()
  const identities = new Set<string>()
  const add = (raw: unknown, namespace?: Record<string, any>) => {
    const tool = record(raw)
    if (!['function', 'custom'].includes(tool.type) || typeof tool.name !== 'string' || !tool.name)
      return
    const ns = typeof namespace?.name === 'string' ? namespace.name : undefined
    const identity = JSON.stringify([ns, tool.name, tool.type])
    if (identities.has(identity)) return
    if (catalog.size >= 1024) throw new Error('Codex tool catalog exceeds 1024 tools')
    identities.add(identity)
    const base = `${ns ? `${ns.replace(/^mcp__/, '')}__` : ''}${tool.name}`.replace(
      /[^A-Za-z0-9_-]/g,
      '_',
    )
    let alias = base.slice(0, 52)
    for (let n = 2; catalog.has(alias); n++) {
      const suffix = `_${n}`
      alias = `${base.slice(0, 52 - suffix.length)}${suffix}`
    }
    const description = [namespace?.description, tool.description]
      .filter((s) => typeof s === 'string')
      .join('\n\n')
    const custom = tool.type === 'custom'
    catalog.set(alias, {
      name: tool.name,
      ...(ns ? { namespace: ns } : {}),
      custom,
      mcpTool: {
        name: alias,
        description: custom
          ? `${description}\n\nPass the tool's raw input text as \`input\`.${tool.format?.definition ? ` It must match this ${tool.format.syntax || ''} grammar:\n${tool.format.definition}` : ''}`
          : description,
        inputSchema: custom
          ? {
              type: 'object',
              properties: {
                input: {
                  type: 'string',
                  description: 'Raw input for this freeform Codex tool, not JSON-encoded.',
                },
              },
              required: ['input'],
            }
          : tool.parameters || { type: 'object', properties: {} },
      },
    })
  }
  for (const raw of Array.isArray(tools) ? tools : []) {
    const tool = record(raw)
    if (tool.type === 'namespace') {
      for (const nested of Array.isArray(tool.tools) ? tool.tools : []) add(nested, tool)
    } else add(tool)
  }
  return catalog
}

export class CodexToolServer {
  private readonly catalog: Map<string, CodexToolEntry>
  private readonly onCall: (call: PendingCodexCall) => void
  private readonly root: string | undefined
  private server: net.Server | null = null
  private socketPath: string | null = null
  private readonly clients = new Set<Socket>()
  private closed = false
  private pending = 0
  private drained: Promise<void> = Promise.resolve()

  constructor(
    catalog: Map<string, CodexToolEntry>,
    onCall: (call: PendingCodexCall) => void,
    root?: string,
  ) {
    this.catalog = catalog
    this.onCall = onCall
    this.root = root
  }
  async listen(): Promise<string> {
    if (this.closed || this.server) throw new Error('Codex tool server already started or closed')
    const dir = join(this.root ?? anyengineRoot(), 'router', 'tools')
    const path = join(dir, `t-${randomBytes(4).toString('hex')}.sock`)
    if (Buffer.byteLength(path) > socketPathLimit())
      throw new Error(
        `Codex tool socket path exceeds the ${socketPathLimit()}-byte limit; use a shorter AnyEngine root`,
      )
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    this.socketPath = path
    const server = net.createServer((socket) => this.serve(socket))
    this.server = server
    this.drained = new Promise<void>((resolve) => server.once('close', resolve))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', () => this.close())
    return path
  }
  private serve(socket: Socket): void {
    if (this.closed || this.clients.size >= 16) {
      socket.destroy()
      return
    }
    this.clients.add(socket)
    socket.on('error', () => socket.destroy())
    const send = (message: object) => {
      try {
        writeLine(socket, { jsonrpc: '2.0', ...message })
      } catch {
        socket.destroy()
      }
    }
    const detach = onLines(
      socket,
      (request) => {
        const { id, method } = request
        if (id === undefined || id === null) return
        const params = record(request.params)
        if (method === 'initialize')
          send({
            id,
            result: {
              protocolVersion: params.protocolVersion || '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'codex', version: '1' },
            },
          })
        else if (method === 'tools/list')
          send({ id, result: { tools: [...this.catalog.values()].map((entry) => entry.mcpTool) } })
        else if (method === 'tools/call') this.call(params, (result) => send({ id, result }))
        else if (method === 'ping') send({ id, result: {} })
        else send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
      },
      () => socket.destroy(),
    )
    socket.once('close', () => {
      detach()
      this.clients.delete(socket)
    })
  }
  private call(params: Record<string, any>, reply: (result: object) => void): void {
    const entry = this.catalog.get(params.name)
    if (!entry || this.pending >= 256) {
      reply({
        content: [
          {
            type: 'text',
            text: entry
              ? 'Too many pending Codex calls.'
              : `Codex does not offer a tool named ${params.name}.`,
          },
        ],
        isError: true,
      })
      return
    }
    this.pending++
    let resolved = false
    this.onCall({
      callId: rid('call_ae_'),
      toolUseId:
        typeof params._meta?.['claudecode/toolUseId'] === 'string'
          ? params._meta['claudecode/toolUseId']
          : null,
      entry,
      args: record(params.arguments),
      resolve: (output, userText) => {
        if (resolved || this.closed) return
        resolved = true
        this.pending--
        const content = codexOutputToMcp(output)
        if (userText)
          content.push({
            type: 'text',
            text: `The user sent this message while the tool was running:\n\n${userText}`,
          })
        reply({ content })
      },
    })
  }
  whenClosed(): Promise<void> {
    return this.drained
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const socket of this.clients) socket.destroy()
    this.clients.clear()
    this.server?.close()
    if (this.socketPath) rmSync(this.socketPath, { force: true })
  }
}

export interface WaitingTurn {
  threadId: string | null
  engineRoot: string
  ownerPath: string | null
  resume(stream: ResponsesStream, results: CodexResults): boolean
  cancel(): Promise<void>
  ownerCurrent(): boolean
}
export interface CodexResults {
  turn: WaitingTurn
  results: Map<string, unknown>
  userText: string
}
const waitingCalls = new Map<string, WaitingTurn>()
const liveTurns = new Set<WaitingTurn>()
export function trackCodexTurn(turn: WaitingTurn): () => void {
  if (liveTurns.size >= 512) throw new Error('Too many active Claude turns')
  liveTurns.add(turn)
  return () => {
    liveTurns.delete(turn)
    forgetCodexCalls(turn)
  }
}
export function waitForCodexResults(calls: PendingCodexCall[], turn: WaitingTurn): void {
  for (const call of calls) waitingCalls.set(call.callId, turn)
}
export function forgetCodexCalls(turn: WaitingTurn): void {
  for (const [id, owner] of waitingCalls) if (owner === turn) waitingCalls.delete(id)
}
function outputs(input: unknown): Array<Record<string, any>> {
  return Array.isArray(input)
    ? input.filter((item) =>
        ['function_call_output', 'custom_tool_call_output'].includes(item?.type),
      )
    : []
}
export function hasWaitingCodexResults(input: unknown): boolean {
  return outputs(input).some((item) => waitingCalls.has(item.call_id))
}
export function findCodexResults(input: unknown): CodexResults | null {
  if (!Array.isArray(input)) return null
  let turn: WaitingTurn | undefined
  let last = -1
  const results = new Map<string, unknown>()
  for (const [index, item] of input.entries()) {
    if (!['function_call_output', 'custom_tool_call_output'].includes(item?.type)) continue
    const waiting = waitingCalls.get(item.call_id)
    if (!waiting) continue
    if (turn && waiting !== turn) return null
    turn = waiting
    results.set(item.call_id, item.output)
    last = index
  }
  if (!turn) return null
  const userText: string[] = []
  for (const item of input.slice(last + 1)) {
    if (item?.type !== 'message' || item.role !== 'user') continue
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type !== 'input_text' || typeof part.text !== 'string') continue
      const kind = classifyUserText(part.text)
      if (kind === 'prompt' || kind === 'context') userText.push(part.text)
      else if (kind === 'aborted')
        userText.push('(The user stopped the turn while this tool was running.)')
    }
  }
  return { turn, results, userText: userText.join('\n\n') }
}
export async function cancelWaitingCodexTurns(
  threadId: string | null,
  engineRoot?: string,
  keep?: WaitingTurn,
): Promise<void> {
  if (!threadId) return
  await Promise.all(
    [...liveTurns]
      .filter(
        (turn) =>
          turn !== keep &&
          turn.threadId === threadId &&
          (!engineRoot || turn.engineRoot === engineRoot),
      )
      .map((turn) => turn.cancel()),
  )
}
export async function closeCodexTurns(engineRoot: string): Promise<void> {
  await Promise.all(
    [...liveTurns].filter((turn) => turn.engineRoot === engineRoot).map((turn) => turn.cancel()),
  )
}
export function codexOutputToMcp(output: unknown): Array<Record<string, unknown>> {
  let items: Array<Record<string, any>> = []
  if (typeof output === 'string') items = [{ text: output }]
  else if (Array.isArray(output)) items = output
  else if (output && typeof output === 'object')
    items = [
      {
        text:
          typeof record(output).content === 'string'
            ? record(output).content
            : JSON.stringify(output),
      },
    ]
  const content: Array<Record<string, unknown>> = []
  for (const item of items) {
    if (typeof item?.text === 'string') content.push({ type: 'text', text: item.text })
    else if (typeof item?.image_url === 'string') {
      const match = item.image_url.match(/^data:([^;,]+);base64,(.*)$/s)
      content.push(
        match
          ? { type: 'image', mimeType: match[1], data: match[2] }
          : { type: 'text', text: item.image_url },
      )
    }
  }
  return content.length ? content : [{ type: 'text', text: '(The tool returned no output.)' }]
}
