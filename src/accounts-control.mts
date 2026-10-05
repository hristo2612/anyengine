import { chmodSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { entry, privateDirectory } from './accounts-files.mjs'
import type { AccountLedger } from './accounts-ledger.mjs'
import type { OwnerToken, Participant } from './accounts-types.mjs'

type Request = {
  command: 'stop' | 'restart' | 'reconcile' | 'policy' | 'retire'
  generation: number
  owner?: OwnerToken
}
export interface AccountControlHooks {
  stop(): Promise<void>
  restart(): Promise<void>
  reconcile?(): Promise<void>
  policy?(): void
  retire?(): Promise<void>
}
function receive(socket: Socket, consume: (value: unknown) => void): void {
  let text = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.setTimeout(30_000, () => socket.destroy())
  socket.on('data', (part) => {
    text += part
    if (Buffer.byteLength(text) > 16_384) return socket.destroy()
    const end = text.indexOf('\n')
    if (end < 0) return
    socket.removeAllListeners('data')
    try {
      consume(JSON.parse(text.slice(0, end)))
    } catch {
      socket.destroy()
    }
  })
}
async function dispatchControl(
  ledger: AccountLedger,
  hooks: AccountControlHooks,
  value: unknown,
): Promise<void> {
  const r = value as Request
  if (!r || !Number.isSafeInteger(r.generation)) throw new Error('Invalid account control')
  if (r.command === 'stop') {
    if (!r.owner || ledger.requireOwner(r.owner).generation !== r.generation)
      throw new Error('Stale account stop request')
    await hooks.stop()
    return
  }
  if (r.command === 'retire') {
    if (
      !r.owner ||
      ledger.requireOwner(r.owner).phase !== 'stopped' ||
      ledger.requireOwner(r.owner).generation !== r.generation ||
      ledger.holders().length ||
      ledger.workCount()
    )
      throw new Error('Account retirement requires stopped families')
    if (!hooks.retire) throw new Error('Account participant cannot retire')
    await hooks.retire()
    return
  }
  if (r.command === 'reconcile') {
    if (
      !r.owner ||
      ledger.requireOwner(r.owner).phase !== 'stopped' ||
      ledger.holders().length ||
      ledger.workCount()
    )
      throw new Error('Account reconciliation requires stopped families')
    await hooks.reconcile?.()
    return
  }
  if (r.command !== 'restart' && r.command !== 'policy')
    throw new Error('Unknown account control command')
  const s = ledger.state()
  if (s.phase !== 'open' || s.generation !== r.generation)
    throw new Error('Account admission is frozen')
  if (r.command === 'policy') hooks.policy?.()
  else await hooks.restart()
}
export async function startAccountControl(
  ledger: AccountLedger,
  participant: Participant,
  hooks: AccountControlHooks,
): Promise<{ close(): Promise<void> }> {
  privateDirectory(ledger.metadata.paths.root)
  if (entry(participant.socket)) throw new Error('Account control socket already exists')
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    receive(socket, (value) => {
      void dispatchControl(ledger, hooks, value)
        .then(() => {
          socket.end(`${JSON.stringify({ ok: true, generation: ledger.state().generation })}\n`)
        })
        .catch(() => socket.end('{"ok":false}\n'))
    })
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(participant.socket, () => {
      server.off('error', reject)
      done()
    })
  })
  chmodSync(participant.socket, 0o600)
  const identity = entry(participant.socket)
  return {
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      )
      const current = entry(participant.socket)
      if (current && identity && current.dev === identity.dev && current.ino === identity.ino)
        unlinkSync(participant.socket)
    },
  }
}
export async function accountControl(participant: Participant, request: Request): Promise<void> {
  const s = entry(participant.socket)
  if (!s?.isSocket() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600)
    throw new Error('Account participant control unavailable')
  await new Promise<void>((done, reject) => {
    const socket = createConnection(participant.socket)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('Account control timed out'))
    }, 30_000)
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else done()
    }
    socket.once('error', finish)
    socket.once('close', () => finish(new Error('Account control disconnected')))
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    receive(socket, (value) => {
      if ((value as { ok?: unknown })?.ok !== true)
        finish(new Error('Account participant refused control'))
      else finish()
    })
  })
}
