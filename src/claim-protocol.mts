// Private, one-request NDJSON connections between the router and an adapter.
// A disconnected caller cancels its claim; frames and queued writes are bounded.
import { lstatSync, readdirSync } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'

export interface OwnsRequest {
  op: 'owns'
  threadId: string
  as?: 'child' | 'parent'
}

export interface ClaimRequest {
  op: 'claim'
  threadId: string
  parentThreadId: string | null
  turnId: string | null
  model: string
  prompt: string
  cwd: string | null
  effort: string | null
}

export type ClaimEvent =
  | { type: 'unknown' }
  | { type: 'accepted'; posture: string; cwd: string }
  | { type: 'progress'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'done'; success: boolean; text: string }
  | { type: 'error'; message: string }
  | { type: 'pong'; pid: number; threads: number }
  // Successful ownership always reports the adapter record's trusted root.
  // Null means use an empty private trampoline directory, never request cwd.
  | { type: 'owns'; owned: true; cwd: string | null }
  | { type: 'owns'; owned: false }

const FRAME_BYTES = 8 * 1024 * 1024
// Ownership clients allow announcement grace plus this read fallback and a
// small transport margin. `owns` ends its connection after one answer.
export const CLAIM_DISCOVERY_READ_MS = 5000

export function claimSocketPath(runDir: string, pid: number = process.pid): string {
  return join(runDir, `claim-${pid}.sock`)
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function liveClaimSockets(runDir: string): string[] {
  try {
    return readdirSync(runDir)
      .flatMap((name) => {
        const match = /^claim-(\d+)\.sock$/.exec(name)
        const path = join(runDir, name)
        try {
          return match && alive(Number(match[1])) && lstatSync(path).isSocket() ? [path] : []
        } catch {
          return []
        }
      })
      .sort()
  } catch {
    return []
  }
}

export function writeLine(socket: Socket, message: object): void {
  if (socket.destroyed || !socket.writable || socket.writableEnded) return
  const line = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(line) + socket.writableLength > FRAME_BYTES)
    throw new Error('claim output exceeds the 8 MiB limit')
  socket.write(line)
}

export function onLines(
  socket: Socket,
  handle: (message: Record<string, unknown>) => void,
  onError?: () => void,
): () => void {
  let pending = ''
  let failed = false
  const fail = () => {
    if (failed) return
    failed = true
    pending = ''
    if (onError) {
      onError()
      return
    }
    if (!socket.destroyed && !socket.writableEnded)
      socket.end(
        `${JSON.stringify({ type: 'error', message: 'invalid or oversized claim frame' })}\n`,
      )
  }
  socket.setEncoding('utf8')
  const data = (chunk: string) => {
    if (failed) return
    pending += chunk
    for (;;) {
      if (failed) return
      const end = pending.indexOf('\n')
      if (end < 0) break
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      try {
        if (Buffer.byteLength(line) > FRAME_BYTES) throw new Error('oversized frame')
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('not an object')
        handle(value as Record<string, unknown>)
      } catch {
        fail()
        return
      }
    }
    if (Buffer.byteLength(pending) > FRAME_BYTES) fail()
  }
  const end = () => {
    if (pending) fail()
  }
  const close = () => {
    pending = ''
  }
  socket.on('data', data)
  socket.on('end', end)
  socket.once('close', close)
  return () => {
    failed = true
    pending = ''
    socket.off('data', data)
    socket.off('end', end)
    socket.off('close', close)
  }
}
