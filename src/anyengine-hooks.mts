import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { debugLog } from './util.mjs'

// Claude Code hook payload as delivered by scripts/anyengine-hook-relay.mjs.
// Field names follow Claude Code's hook JSON verbatim (snake_case).
export interface HookPayload {
  hook_event_name: string
  session_id?: string
  transcript_path?: string
  cwd?: string
  prompt_id?: string
  permission_mode?: string
  tool_name?: string
  tool_input?: unknown
  tool_use_id?: string
  tool_response?: unknown
  last_assistant_message?: string
  // UserPromptSubmit: the submitted text (system-injected task notifications
  // for background sub-agents arrive through the same hook).
  prompt?: string
  // SubagentStop (2.1.x): id/type of the sub-agent and its own transcript.
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  // StopFailure: rate_limit | authentication_failed | billing_error |
  // invalid_request | server_error | max_output_tokens | unknown
  error?: string
  error_details?: string
  notification_type?: string
  message?: string
  [key: string]: unknown
}

export const PTY_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'Notification',
  'SessionEnd',
] as const

export type HookResponder = (threadId: string, payload: HookPayload) => Promise<unknown>

export const HOOK_TOKEN_HEADER = 'x-anyengine-hook-token'

// Loopback HTTP endpoint the relay script posts every hook to. A random token
// (handed to each PTY through its environment) keeps stray local processes
// from injecting hook events; the server never logs it.
export class PtyHookServer {
  private server: http.Server | null = null
  private readonly responder: HookResponder
  readonly token: string
  port = 0

  constructor(responder: HookResponder) {
    this.responder = responder
    this.token = randomBytes(24).toString('hex')
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/hook`
  }

  async start(): Promise<number> {
    if (this.server) return this.port
    const server = http.createServer((req, res) => this.handle(req, res))
    server.on('clientError', (_err, socket) => {
      try {
        socket.destroy()
      } catch {}
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    this.port = typeof address === 'object' && address ? address.port : 0
    return this.port
  }

  stop(): void {
    const server = this.server
    this.server = null
    if (!server) return
    try {
      server.close()
      server.closeAllConnections?.()
    } catch {}
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.headers[HOOK_TOKEN_HEADER] !== this.token) {
      res.writeHead(403).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('error', () => {
      try {
        res.destroy()
      } catch {}
    })
    req.on('end', () => {
      let body: { threadId?: unknown; hook?: unknown }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      const threadId = typeof body.threadId === 'string' ? body.threadId : ''
      const hook = body.hook
      if (!threadId || !hook || typeof hook !== 'object' || Array.isArray(hook)) {
        res.writeHead(400).end()
        return
      }
      const payload = hook as HookPayload
      if (typeof payload.hook_event_name !== 'string') {
        res.writeHead(400).end()
        return
      }
      void this.responder(threadId, payload)
        .then((reply) => {
          if (reply == null) {
            res.writeHead(204).end()
            return
          }
          const text = JSON.stringify(reply)
          res.writeHead(200, { 'content-type': 'application/json' }).end(text)
        })
        .catch((err) => {
          debugLog('anyengine.hook.error', {
            threadId,
            hook: payload.hook_event_name,
            error: err instanceof Error ? err.message : String(err),
          })
          try {
            res.writeHead(500).end()
          } catch {}
        })
    })
  }
}

export interface PtySettingsOptions {
  threadId: string
  // Unique per spawn so disposing a superseded PTY never removes the files a
  // fresh respawn of the same thread is about to read.
  fileStem: string
  relayScript: string
  nodeBinary: string
  // Seconds Claude Code waits for a hook command before killing it. PreToolUse
  // blocks on the Codex App's approval dialog, so this must comfortably exceed
  // how long a human may take to answer.
  hookTimeoutSec: number
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildPtySettings(options: PtySettingsOptions): Record<string, unknown> {
  const command = `${shellQuote(options.nodeBinary)} ${shellQuote(options.relayScript)} ${shellQuote(options.threadId)}`
  const matcher = () => ({
    hooks: [{ type: 'command', command, timeout: options.hookTimeoutSec }],
  })
  const hooks: Record<string, unknown> = {}
  for (const event of PTY_HOOK_EVENTS) hooks[event] = [matcher()]
  return { hooks }
}

// Per-thread settings JSON (hooks only) written 0600 under the runtime's
// private state dir and passed to the CLI as `--settings <file>`.
export function writePtySettings(dir: string, options: PtySettingsOptions): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${safeFileName(options.fileStem)}.settings.json`)
  writeJsonFile(file, buildPtySettings(options))
  return file
}

export function writePtyMcpConfig(dir: string, fileStem: string, mcpServers: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${safeFileName(fileStem)}.mcp.json`)
  const config =
    mcpServers && typeof mcpServers === 'object' && 'mcpServers' in (mcpServers as object)
      ? mcpServers
      : { mcpServers }
  writeJsonFile(file, config)
  return file
}

function writeJsonFile(file: string, value: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_')
}
