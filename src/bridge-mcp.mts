import readline from 'node:readline'
import { WebSocket } from 'ws'
import {
  BRIDGE_ENV_SOCKET,
  BRIDGE_ENV_THREAD,
  BRIDGE_ENV_TOKEN,
  BRIDGE_THREAD_HEADER,
  DEFAULT_WAIT_TIMEOUT_MS,
} from './bridge-control.mjs'
import { MODEL_ALIAS_TABLE } from './bridge-instructions.mjs'

// `anyengine`: the stdio MCP server every engine process gets
// (`node dist/src/adapter.mjs bridge-mcp`, or scripts/bridge-mcp.mjs). It is
// deliberately thin: JSON-RPC 2.0 over newline-delimited stdio for the MCP
// handshake and tool surface, and one WebSocket to the adapter's bridge
// control socket (src/bridge-control.mts) for the actual work. The calling
// thread is passed by the runtime that spawned the engine in
// ANYENGINE_BRIDGE_THREAD; when absent (the codex child runs one bridge per
// process) the adapter infers it from the single thread with a turn in flight.

const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
const LATEST_PROTOCOL = '2025-06-18'
const MODEL_HINT = `Which engine or model, as the user said it: "claude opus", "opus 5", "grok", "gpt", "grok-4.6", "Claude Sonnet", "gpt-5.6-sol". ${MODEL_ALIAS_TABLE} Unknown names are refused with the list of valid ids.`
const TIMEOUT_PROP = {
  type: 'integer',
  description: `Milliseconds to wait for the turn (default ${DEFAULT_WAIT_TIMEOUT_MS}).`,
}

export const BRIDGE_TOOLS = [
  {
    name: 'list_models',
    description:
      'List the AI engines and models available right now: Claude (Claude Code), Grok (xAI Grok Build) and GPT (native Codex, when attached). Returns ids, display names and providers; call it only when unsure what exists, the other tools accept informal names directly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'spawn_session',
    description: `Start a new conversation on another AI engine (Claude, Grok, GPT) and send it a first message. Use when the user says "spawn a session with X", "ask X to ...", "hand this off to X", "delegate this to X". The session appears in the App sidebar; waits for the reply by default and returns {threadId, status, text}. Continue it with send_to_session. ${MODEL_ALIAS_TABLE}`,
    inputSchema: {
      type: 'object',
      required: ['model', 'prompt'],
      properties: {
        model: { type: 'string', description: MODEL_HINT },
        prompt: { type: 'string', description: 'The first user message of the new session.' },
        cwd: { type: 'string', description: "Working directory (default: the calling thread's)." },
        title: { type: 'string', description: 'Optional sidebar name for the new session.' },
        wait: {
          type: 'boolean',
          description: 'false returns right after the turn starts (default true).',
        },
        timeoutMs: TIMEOUT_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'spawn_subagents',
    description: `Run several tasks in parallel on chosen engines (Claude, Grok, GPT) as sub-agents of the current thread and return every result. Use when the user says "spawn N sub-agents", "run this in parallel with 3 grok agents", "2 with grok and 2 with claude": one task per agent, each with its own model and prompt. They render as native sub-agents under the current thread and inherit its working directory and approval policy. ${MODEL_ALIAS_TABLE}`,
    inputSchema: {
      type: 'object',
      required: ['tasks'],
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['model', 'prompt'],
            properties: {
              model: { type: 'string', description: MODEL_HINT },
              prompt: { type: 'string', description: 'The task for this sub-agent.' },
              name: {
                type: 'string',
                description: 'Optional label shown in the App (e.g. "grok-1", "claude-2").',
              },
            },
            additionalProperties: false,
          },
        },
        cwd: { type: 'string', description: 'Working directory for all tasks.' },
        parentThreadId: {
          type: 'string',
          description: 'Only when the bridge cannot infer the calling thread.',
        },
        timeoutMs: TIMEOUT_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'send_to_session',
    description:
      'Continue a conversation you (or the user) already started on another engine: send a follow-up message to an existing session by thread id and, by default, wait for its reply.',
    inputSchema: {
      type: 'object',
      required: ['threadId', 'prompt'],
      properties: {
        threadId: { type: 'string' },
        prompt: { type: 'string' },
        wait: { type: 'boolean', description: 'false returns right after the turn starts.' },
        timeoutMs: TIMEOUT_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait_session',
    description:
      'Wait for the turn currently running in a session (started with wait:false, or by someone else) and return its text. When nothing is running it returns the last finished turn, or status "idle" for a session that never ran.',
    inputSchema: {
      type: 'object',
      required: ['threadId'],
      properties: { threadId: { type: 'string' }, timeoutMs: TIMEOUT_PROP },
      additionalProperties: false,
    },
  },
] as const

const TOOL_TO_METHOD: Record<string, string> = {
  list_models: 'bridge/models',
  spawn_session: 'bridge/spawnSession',
  spawn_subagents: 'bridge/spawnSubagents',
  send_to_session: 'bridge/send',
  wait_session: 'bridge/wait',
}

// ---- control client ------------------------------------------------------

export class BridgeClient {
  private readonly socketPath: string
  private readonly token: string
  private readonly threadId: string | null
  private ws: WebSocket | null = null
  private opening: Promise<WebSocket> | null = null
  private nextId = 0
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.socketPath = env[BRIDGE_ENV_SOCKET]?.trim() ?? ''
    this.token = env[BRIDGE_ENV_TOKEN]?.trim() ?? ''
    this.threadId = env[BRIDGE_ENV_THREAD]?.trim() || null
  }

  get configured(): boolean {
    return this.socketPath.length > 0 && this.token.length > 0
  }

  async call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const ws = await this.connect()
    const id = `m${++this.nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge request timed out: ${method}`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {}
  }

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws)
    if (this.opening) return this.opening
    if (!this.configured) {
      return Promise.reject(
        new Error(
          `bridge not configured: ${BRIDGE_ENV_SOCKET} / ${BRIDGE_ENV_TOKEN} missing from the environment`,
        ),
      )
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    if (this.threadId) headers[BRIDGE_THREAD_HEADER] = this.threadId
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${this.socketPath}:/bridge`, { headers })
      ws.once('open', () => {
        this.ws = ws
        this.opening = null
        resolve(ws)
      })
      ws.once('error', (error) => {
        this.opening = null
        reject(new Error(`bridge connect failed (${this.socketPath}): ${error.message}`))
      })
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null
        for (const entry of this.pending.values())
          entry.reject(new Error('bridge connection closed'))
        this.pending.clear()
      })
      ws.on('message', (data) => {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
        } catch {
          return
        }
        const entry = this.pending.get(String(message.id))
        if (!entry) return
        this.pending.delete(String(message.id))
        const error = message.error as { message?: string } | undefined
        if (error) entry.reject(new Error(error.message ?? 'bridge error'))
        else entry.resolve(message.result)
      })
    })
    return this.opening
  }
}

// ---- MCP over stdio -------------------------------------------------------

type Json = Record<string, unknown>

export function runBridgeMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const client = new BridgeClient(env)
  const write = (message: Json) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: Json
    try {
      message = JSON.parse(trimmed) as Json
    } catch {
      write({ id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    void handleMcpMessage(message, client, write)
  })
  return new Promise((resolve) => {
    rl.on('close', () => {
      client.close()
      resolve()
    })
  })
}

async function handleMcpMessage(
  message: Json,
  client: BridgeClient,
  write: (message: Json) => void,
): Promise<void> {
  const method = typeof message.method === 'string' ? message.method : null
  const id = message.id as string | number | null | undefined
  if (!method) return
  const isNotification = id === undefined
  const params = asRecord(message.params)
  try {
    let result: unknown
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        result = {
          protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'anyengine', version: '0.1.0' },
          instructions: `Cross-engine bridge: start conversations or parallel sub-agents on the other AI engines (Claude, Grok, GPT) from this thread. When the user names an engine or says spawn / delegate / hand off / ask X, call these tools right away without asking for confirmation. spawn_subagents for parallel work, spawn_session for a standalone conversation. ${MODEL_ALIAS_TABLE}`,
        }
        break
      }
      case 'ping':
        result = {}
        break
      case 'tools/list':
        result = { tools: BRIDGE_TOOLS }
        break
      case 'resources/list':
        result = { resources: [] }
        break
      case 'prompts/list':
        result = { prompts: [] }
        break
      case 'tools/call':
        result = await callTool(client, params)
        break
      default:
        if (method.startsWith('notifications/')) return
        if (isNotification) return
        write({ id, error: { code: -32601, message: `Method not found: ${method}` } })
        return
    }
    if (!isNotification) write({ id, result })
  } catch (error) {
    if (isNotification) return
    write({
      id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    })
  }
}

async function callTool(client: BridgeClient, params: Json): Promise<unknown> {
  const name = typeof params.name === 'string' ? params.name : ''
  const args = asRecord(params.arguments)
  const method = TOOL_TO_METHOD[name]
  if (!method) throw new Error(`Unknown tool: ${name}`)
  const timeout = Number(args.timeoutMs)
  const waitMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_WAIT_TIMEOUT_MS
  try {
    // The adapter enforces the wait; this cap only catches a dead socket.
    const result = asRecord(await client.call(method, args, waitMs + 30_000))
    return {
      content: [{ type: 'text', text: renderResult(name, result) }],
      structuredContent: result,
      isError: false,
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: 'text', text: `anyengine ${name} failed: ${text}` }],
      isError: true,
    }
  }
}

// Plain-text rendering for the model; structuredContent carries the fields.
export function renderResult(tool: string, result: Json): string {
  switch (tool) {
    case 'list_models': {
      const models = Array.isArray(result.models) ? result.models.map((m) => asRecord(m)) : []
      return models
        .map((m) => `${m.id}  (${m.displayName}, ${m.provider}${m.isDefault ? ', default' : ''})`)
        .join('\n')
    }
    case 'spawn_subagents': {
      const results = Array.isArray(result.results) ? result.results.map((r) => asRecord(r)) : []
      return results
        .map((r) => {
          const head = `[${r.name}] model=${r.model ?? '?'} thread=${r.threadId ?? '-'} status=${r.status}`
          const body = r.error ? `error: ${r.error}` : String(r.text ?? '')
          return `${head}\n${body}`
        })
        .join('\n\n')
    }
    default: {
      const head = `thread=${result.threadId ?? '-'} turn=${result.turnId ?? '-'} status=${result.status ?? '?'}`
      const body = result.error ? `error: ${result.error}` : String(result.text ?? '')
      return body ? `${head}\n${body}` : head
    }
  }
}

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}
