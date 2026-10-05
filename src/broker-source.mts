// A private adapter-to-router channel. The bearer crosses IPC only in memory.
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net, { type Socket } from 'node:net'
import { join } from 'node:path'
import type { ActiveAccount, AuthSource, AuthStatus } from './broker-types.mjs'
import { socketPathLimit } from './util.mjs'

const LIMIT = 32 * 1024
const DEADLINE = 10_000
const ID = /^[a-f0-9]{24}$/
const fail = (code = 'source-unavailable') => new Error(`broker.${code}`)

export interface BrokerRegistration {
  id: string
  childId: string
  pid: number
  home: string
  generation: number
  socket: string
  registeredAt: number
}

function owned(path: string, mode: number, kind: 'directory' | 'file' | 'socket'): boolean {
  const stat = lstatSync(path)
  return (
    !stat.isSymbolicLink() &&
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o777) === mode &&
    (kind === 'directory'
      ? stat.isDirectory()
      : kind === 'socket'
        ? stat.isSocket()
        : stat.isFile() && stat.nlink === 1)
  )
}

export function brokerSourceDir(root: string, create = false): string {
  const base = realpathSync(root)
  let current = base
  for (const part of ['broker', 'sources']) {
    current = join(current, part)
    if (create) {
      try {
        mkdirSync(current, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fail('unsafe-directory')
      }
    }
    if (!owned(current, 0o700, 'directory')) throw fail('unsafe-directory')
  }
  return current
}

function live(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function readBrokerSources(root: string, account: ActiveAccount): BrokerRegistration[] {
  try {
    const dir = brokerSourceDir(root)
    const home = realpathSync(account.home)
    const sources: BrokerRegistration[] = []
    for (const name of readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .slice(0, 256)) {
      try {
        const path = join(dir, name)
        if (!owned(path, 0o600, 'file') || lstatSync(path).size > LIMIT) continue
        const row = JSON.parse(readFileSync(path, 'utf8')) as BrokerRegistration
        if (
          typeof row.id !== 'string' ||
          !ID.test(row.id) ||
          name !== `${row.id}.json` ||
          typeof row.childId !== 'string' ||
          !row.childId ||
          row.childId.length > 128 ||
          !Number.isSafeInteger(row.pid) ||
          row.pid <= 0 ||
          !live(row.pid) ||
          row.home !== home ||
          row.generation !== account.generation ||
          row.socket !== join(dir, `${row.id}.sock`) ||
          !owned(row.socket, 0o600, 'socket')
        )
          continue
        sources.push({ ...row, registeredAt: lstatSync(path).mtimeMs })
      } catch {
        /* Stale or malformed registrations never authorize an RPC. */
      }
    }
    return sources.sort((a, b) => a.registeredAt - b.registeredAt || a.id.localeCompare(b.id))
  } catch {
    return []
  }
}

function lines(socket: Socket, receive: (row: Record<string, unknown>) => void): void {
  let bytes = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    try {
      bytes = Buffer.concat([bytes, chunk])
      for (;;) {
        const end = bytes.indexOf(10)
        if ((end < 0 ? bytes.length : end) > LIMIT) throw fail()
        if (end < 0) return
        const row = JSON.parse(
          new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, end)),
        )
        bytes = bytes.subarray(end + 1)
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw fail()
        receive(row)
      }
    } catch {
      socket.destroy()
    }
  })
}

function write(socket: Socket, row: unknown): void {
  const frame = `${JSON.stringify(row)}\n`
  if (Buffer.byteLength(frame) > LIMIT) throw fail()
  socket.write(frame)
}

function authShape(value: unknown): value is AuthStatus {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    (row.authMethod === null || typeof row.authMethod === 'string') &&
    (row.authToken === null || typeof row.authToken === 'string') &&
    typeof row.requiresOpenaiAuth === 'boolean'
  )
}

export async function startBrokerSource(input: {
  root: string
  home: string
  generation: number
  childId: string
  pid: number
  request: AuthSource['request']
  isCurrent?: () => boolean
}): Promise<{ id: string; close(): Promise<void> }> {
  const dir = brokerSourceDir(input.root, true)
  const home = realpathSync(input.home)
  if (
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    !input.childId ||
    input.childId.length > 128 ||
    !Number.isSafeInteger(input.pid) ||
    input.pid <= 0
  )
    throw fail('invalid-source')
  const id = randomUUID().replaceAll('-', '').slice(0, 24),
    socketPath = join(dir, `${id}.sock`),
    metadata = join(dir, `${id}.json`)
  if (Buffer.byteLength(socketPath) > socketPathLimit()) throw fail('socket-path-too-long')
  const registration = {
    id,
    childId: input.childId,
    pid: input.pid,
    home,
    generation: input.generation,
    socket: socketPath,
  }
  const sockets = new Set<Socket>()
  let stopped = false,
    closing: Promise<void> | null = null
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    if (stopped || sockets.size >= 32) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    write(socket, { ready: registration })
    let busy = false
    lines(socket, (row) => {
      const params = row.params as Record<string, unknown> | undefined
      if (
        stopped ||
        busy ||
        !Number.isSafeInteger(row.id) ||
        row.method !== 'getAuthStatus' ||
        !params ||
        params.includeToken !== true ||
        typeof params.refreshToken !== 'boolean' ||
        Object.keys(params).some((key) => !['includeToken', 'refreshToken'].includes(key))
      ) {
        socket.destroy()
        return
      }
      busy = true
      socket.setTimeout(DEADLINE, () => socket.destroy())
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_ok, reject) => {
        timer = setTimeout(() => reject(fail()), DEADLINE)
      })
      void Promise.race([
        Promise.resolve().then(() =>
          input.request('getAuthStatus', {
            includeToken: true,
            refreshToken: params.refreshToken as boolean,
          }),
        ),
        timeout,
      ])
        .then((auth) => {
          if (stopped || socket.destroyed) return
          if (!authShape(auth)) throw fail()
          // Ignore unrelated vendor fields; none may escape this narrow channel.
          write(socket, {
            id: row.id,
            result: {
              authMethod: auth.authMethod,
              authToken: auth.authToken,
              requiresOpenaiAuth: auth.requiresOpenaiAuth,
            },
          })
        })
        .catch(() => {
          if (!socket.destroyed) socket.destroy()
        })
        .finally(() => {
          clearTimeout(timer)
          busy = false
          socket.setTimeout(0)
        })
    })
  })
  let inode: number | null = null
  const close = () => {
    if (closing) return closing
    stopped = true
    for (const socket of sockets) socket.destroy()
    try {
      rmSync(metadata)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fail()
    }
    closing = new Promise<void>((done) =>
      server.close(() => {
        try {
          if (inode !== null && lstatSync(socketPath).ino === inode) rmSync(socketPath)
        } catch {}
        done()
      }),
    )
    return closing
  }
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        done()
      })
    })
    inode = lstatSync(socketPath).ino
    if (input.isCurrent && !input.isCurrent()) throw fail('source-changed')
    chmodSync(socketPath, 0o600)
    writeFileSync(metadata, `${JSON.stringify(registration)}\n`, { flag: 'wx', mode: 0o600 })
    server.on('error', () => {
      void close()
    })
    return { id, close }
  } catch {
    await close()
    throw fail()
  }
}

export async function connectBrokerSource(
  meta: BrokerRegistration,
  lost: () => void,
): Promise<AuthSource & { close(): Promise<void> }> {
  const socket = net.connect(meta.socket)
  let ready = false,
    stopped = false,
    next = 0
  const pending = new Map<
    number,
    { resolve: (auth: AuthStatus) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  let readyResolve: () => void = () => {},
    readyReject: (error: Error) => void = () => {}
  const handshake = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const closed = new Promise<void>((done) => socket.once('close', () => done()))
  const drop = () => {
    if (stopped) return
    stopped = true
    readyReject(fail())
    for (const call of pending.values()) {
      clearTimeout(call.timer)
      call.reject(fail())
    }
    pending.clear()
    socket.destroy()
    lost()
  }
  socket.on('error', drop)
  socket.once('close', drop)
  const timer = setTimeout(drop, DEADLINE)
  lines(socket, (row) => {
    if (!ready) {
      const observed = row.ready as Partial<BrokerRegistration> | undefined
      if (
        !observed ||
        ['id', 'childId', 'pid', 'home', 'generation', 'socket'].some(
          (key) =>
            observed[key as keyof BrokerRegistration] !== meta[key as keyof BrokerRegistration],
        )
      ) {
        drop()
        return
      }
      ready = true
      readyResolve()
      return
    }
    const call = pending.get(Number(row.id))
    if (!call || !authShape(row.result)) {
      drop()
      return
    }
    pending.delete(Number(row.id))
    clearTimeout(call.timer)
    call.resolve(row.result)
  })
  try {
    await handshake
  } catch {
    await closed
    throw fail()
  } finally {
    clearTimeout(timer)
  }
  return {
    id: meta.id,
    kind: 'adapter',
    home: meta.home,
    generation: meta.generation,
    request(method, params) {
      if (
        stopped ||
        method !== 'getAuthStatus' ||
        params.includeToken !== true ||
        typeof params.refreshToken !== 'boolean'
      )
        return Promise.reject(fail())
      const id = ++next
      return new Promise<AuthStatus>((resolve, reject) => {
        pending.set(id, { resolve, reject, timer: setTimeout(drop, DEADLINE) })
        try {
          write(socket, {
            id,
            method: 'getAuthStatus',
            params: { includeToken: true, refreshToken: params.refreshToken },
          })
        } catch {
          drop()
        }
      })
    },
    async close() {
      drop()
      await closed
    },
  }
}
