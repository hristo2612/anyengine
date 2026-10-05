// Select ownership once, then offer a turn only to that adapter. Losing the
// selected owner fails closed; ownership itself never counts as a claim.

import { setMaxListeners } from 'node:events'
import net from 'node:net'
import { DEFAULT_CONFIG } from './anyengine-config.mjs'
import {
  CLAIM_DISCOVERY_READ_MS,
  type ClaimEvent,
  type ClaimRequest,
  liveClaimSockets,
  onLines,
  writeLine,
} from './claim-protocol.mjs'

export interface AdapterOwner {
  socketPath: string
  cwd: string | null
}
export type ClaimOutcome = 'claimed' | 'unknown' | 'failed'

export function claimTimeoutMs(graceMs: number): number {
  return graceMs + CLAIM_DISCOVERY_READ_MS + 1000
}
const DEFAULT_DEADLINE = claimTimeoutMs(DEFAULT_CONFIG.claims.graceMs)

interface Connection<T> {
  finish(value: T): void
  accepted(): void
}

// All terminal paths detach parsing, timers and abort listeners together.
// Only admission is timed: an accepted turn may stream for as long as needed.
function exchange<T>(
  path: string,
  request: object,
  signal: AbortSignal,
  deadlineMs: number,
  failure: T,
  handle: (message: Record<string, unknown>, connection: Connection<T>) => void,
): Promise<T> {
  if (signal.aborted) return Promise.resolve(failure)
  return new Promise((resolve) => {
    let finished = false
    let detach = () => {}
    const socket = net.connect(path)
    const gone = () => finish(failure)
    const connected = () => {
      try {
        writeLine(socket, request)
      } catch {
        gone()
      }
    }
    const finish = (value: T) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', gone)
      detach()
      socket.off('connect', connected)
      socket.off('error', gone)
      socket.off('close', gone)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(gone, deadlineMs)
    timer.unref()
    detach = onLines(
      socket,
      (message) => {
        if (finished) return
        try {
          handle(message, { finish, accepted: () => clearTimeout(timer) })
        } catch {
          gone()
        }
      },
      gone,
    )
    socket.once('connect', connected)
    socket.on('error', gone)
    socket.once('close', gone)
    signal.addEventListener('abort', gone, { once: true })
    if (signal.aborted) gone()
  })
}

export function adapterOwns(
  runDir: string,
  threadId: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_DEADLINE,
  as: 'child' | 'parent' = 'child',
): Promise<AdapterOwner | null> {
  const paths = liveClaimSockets(runDir)
  if (!paths.length || signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const cancel = new AbortController()
    setMaxListeners(paths.length + 1, cancel.signal)
    let pending = paths.length
    let finished = false
    const abort = () => finish(null)
    const finish = (owner: AdapterOwner | null) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      cancel.abort()
      resolve(owner)
    }
    signal.addEventListener('abort', abort, { once: true })
    for (const socketPath of paths) {
      void adapterOwnsAt(socketPath, threadId, cancel.signal, timeoutMs, as).then((owner) => {
        pending -= 1
        if (owner || pending === 0) finish(owner)
      })
    }
    if (signal.aborted) abort()
  })
}

// Recheck the selected adapter without discovering or switching owners.
export function adapterOwnsAt(
  socketPath: string,
  threadId: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_DEADLINE,
  as: 'child' | 'parent' = 'child',
): Promise<AdapterOwner | null> {
  return exchange<AdapterOwner | null>(
    socketPath,
    { op: 'owns', threadId, as },
    signal,
    timeoutMs,
    null,
    (message, connection) =>
      connection.finish(
        message.type === 'owns' &&
          message.owned === true &&
          (typeof message.cwd === 'string' || message.cwd === null)
          ? { socketPath, cwd: message.cwd }
          : null,
      ),
  )
}

function claimEvent(message: Record<string, unknown>): ClaimEvent | null {
  switch (message.type) {
    case 'accepted':
      return typeof message.posture === 'string' && typeof message.cwd === 'string'
        ? { type: 'accepted', posture: message.posture, cwd: message.cwd }
        : null
    case 'progress':
      return typeof message.text === 'string' ? { type: 'progress', text: message.text } : null
    case 'text':
      return typeof message.delta === 'string' ? { type: 'text', delta: message.delta } : null
    case 'done':
      return typeof message.success === 'boolean' && typeof message.text === 'string'
        ? { type: 'done', success: message.success, text: message.text }
        : null
    case 'error':
      return typeof message.message === 'string'
        ? { type: 'error', message: message.message }
        : null
    case 'unknown':
      return { type: 'unknown' }
    default:
      return null
  }
}

export function claimOnAdapters(
  owner: AdapterOwner,
  request: ClaimRequest,
  onEvent: (event: ClaimEvent) => void,
  signal: AbortSignal,
  timeoutMs = DEFAULT_DEADLINE,
): Promise<ClaimOutcome> {
  let accepted = false
  return exchange<ClaimOutcome>(
    owner.socketPath,
    request,
    signal,
    timeoutMs,
    'failed',
    (message, connection) => {
      const event = claimEvent(message)
      if (!event) return connection.finish('failed')
      if (!accepted) {
        if (event.type === 'unknown') return connection.finish('unknown')
        if (event.type !== 'accepted') return connection.finish('failed')
        accepted = true
        connection.accepted()
      } else if (event.type === 'accepted' || event.type === 'unknown') {
        return connection.finish('failed')
      }
      onEvent(event)
      if (event.type === 'done') connection.finish('claimed')
    },
  )
}
