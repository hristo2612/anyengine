// Workspace-side effects for the Codex app-server protocol: the `fs/*` calls,
// `command/exec*`, `process/*` and the thread shell command. Split out of
// `server.mts`, which was carrying them alongside the thread and turn
// machinery they share nothing with.
//
// The seam is narrow on purpose. Everything here needs exactly two things from
// the server: a way to notify a peer, and somewhere to keep the child
// processes and watchers it owns. Both live in this class, so the protocol
// layer holds one field instead of three maps and a dozen methods.
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, type FSWatcher, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandArray, commandEnv, numberOr, stringOr } from './server-helpers.mjs'
import type { RpcPeer } from './types.mjs'
import { debugLog, newId } from './util.mjs'

/** How this module reaches the client. Same shape as the server's own notify. */
export type NotifyFn = (peer: RpcPeer, notification: { method: string; params: unknown }) => void

export class WorkspaceOps {
  private readonly commandProcesses = new Map<string, ChildProcess>()
  private readonly processHandles = new Map<string, ChildProcess>()
  private readonly fsWatchers = new Map<string, FSWatcher>()

  private readonly notify: NotifyFn

  constructor(notify: NotifyFn) {
    this.notify = notify
  }

  async fsReadFile(params: Record<string, unknown>): Promise<unknown> {
    const { readFile } = await import('node:fs/promises')
    const path = stringOr(params.path ?? params.filePath, '')
    return { dataBase64: (await readFile(path)).toString('base64') }
  }

  async fsReadDirectory(params: Record<string, unknown>): Promise<unknown> {
    const { readdir } = await import('node:fs/promises')
    const path = stringOr(params.path, process.cwd())
    const entries = await readdir(path, { withFileTypes: true })
    return {
      entries: entries.map((entry) => ({
        fileName: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      })),
    }
  }

  async fsGetMetadata(params: Record<string, unknown>): Promise<unknown> {
    const { stat } = await import('node:fs/promises')
    const path = stringOr(params.path, '')
    const metadata = await stat(path)
    return {
      isDirectory: metadata.isDirectory(),
      isFile: metadata.isFile(),
      isSymlink: metadata.isSymbolicLink(),
      createdAtMs: metadata.birthtimeMs,
      modifiedAtMs: metadata.mtimeMs,
    }
  }

  async fsWriteFile(params: Record<string, unknown>): Promise<unknown> {
    const { writeFile } = await import('node:fs/promises')
    const path = stringOr(params.path, '')
    const data =
      typeof params.dataBase64 === 'string'
        ? Buffer.from(params.dataBase64, 'base64')
        : Buffer.alloc(0)
    await writeFile(path, data)
    return {}
  }

  async fsCreateDirectory(params: Record<string, unknown>): Promise<unknown> {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(stringOr(params.path, ''), { recursive: params.recursive !== false })
    return {}
  }

  async fsRemove(params: Record<string, unknown>): Promise<unknown> {
    const { rm } = await import('node:fs/promises')
    await rm(stringOr(params.path, ''), {
      recursive: params.recursive !== false,
      force: params.force !== false,
    })
    return {}
  }

  async fsCopy(params: Record<string, unknown>): Promise<unknown> {
    const { cp } = await import('node:fs/promises')
    await cp(stringOr(params.sourcePath, ''), stringOr(params.destinationPath, ''), {
      recursive: params.recursive === true,
    })
    return {}
  }

  async fsWatch(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const { realpath } = await import('node:fs/promises')
    const watchId = stringOr(params.watchId, newId())
    const path = await realpath(stringOr(params.path, process.cwd()))
    this.fsWatchers.get(watchId)?.close()
    const watcher = watch(path, { persistent: false }, (_eventType, filename) => {
      const changedPath = filename ? `${path}/${String(filename)}` : path
      this.notify(peer, { method: 'fs/changed', params: { watchId, changedPaths: [changedPath] } })
    })
    this.fsWatchers.set(watchId, watcher)
    return { path }
  }

  fsUnwatch(params: Record<string, unknown>): unknown {
    const watchId = stringOr(params.watchId, '')
    this.fsWatchers.get(watchId)?.close()
    this.fsWatchers.delete(watchId)
    return {}
  }

  async commandExec(peer: RpcPeer, params: Record<string, unknown>): Promise<unknown> {
    const processId = typeof params.processId === 'string' ? params.processId : newId()
    const command = commandArray(params.command)
    if (command.length === 0) throw new Error('command/exec requires command')
    if (
      (params.streamStdoutStderr === true || params.streamStdin === true || params.tty === true) &&
      typeof params.processId !== 'string'
    ) {
      throw new Error('command/exec streaming requires processId')
    }

    const executable = command[0] as string
    const streamOutput = params.streamStdoutStderr === true || params.tty === true
    const cwd = stringOr(params.cwd, process.cwd())
    debugLog('command.exec.start', {
      processId,
      cwd,
      command,
      streamOutput,
      streamStdin: params.streamStdin === true,
      tty: params.tty === true,
    })
    const child = spawn(executable, command.slice(1), {
      cwd,
      env: commandEnv(params.env),
      stdio: 'pipe',
    })
    this.commandProcesses.set(processId, child)

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const cap =
      params.disableOutputCap === true
        ? Number.POSITIVE_INFINITY
        : numberOr(params.outputBytesCap, 1_000_000)
    let stdoutBytes = 0
    let stderrBytes = 0

    const capture = (target: Buffer[], chunk: Buffer, currentBytes: number): number => {
      if (currentBytes >= cap) return currentBytes
      const allowed = Math.min(chunk.byteLength, cap - currentBytes)
      if (allowed > 0) target.push(chunk.subarray(0, allowed))
      return currentBytes + allowed
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (streamOutput) {
        this.notify(peer, {
          method: 'command/exec/outputDelta',
          params: {
            processId,
            stream: 'stdout',
            deltaBase64: buffer.toString('base64'),
            capReached: false,
          },
        })
        return
      }
      stdoutBytes = capture(stdout, buffer, stdoutBytes)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (streamOutput) {
        this.notify(peer, {
          method: 'command/exec/outputDelta',
          params: {
            processId,
            stream: 'stderr',
            deltaBase64: buffer.toString('base64'),
            capReached: false,
          },
        })
        return
      }
      stderrBytes = capture(stderr, buffer, stderrBytes)
    })

    const timeoutMs = params.disableTimeout === true ? null : numberOr(params.timeoutMs, 60_000)
    let timeout: NodeJS.Timeout | null = null
    if (timeoutMs != null && timeoutMs > 0) {
      timeout = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    }

    return new Promise((resolve, reject) => {
      child.once('error', (error) => {
        debugLog('command.exec.error', {
          processId,
          error: error.message,
          code: (error as NodeJS.ErrnoException).code,
        })
        if (timeout) clearTimeout(timeout)
        this.commandProcesses.delete(processId)
        reject(error)
      })
      child.once('close', (code, signal) => {
        debugLog('command.exec.close', { processId, code, signal, stdoutBytes, stderrBytes })
        if (timeout) clearTimeout(timeout)
        this.commandProcesses.delete(processId)
        resolve({
          exitCode: code ?? 1,
          stdout: streamOutput ? '' : Buffer.concat(stdout).toString('utf8'),
          stderr: streamOutput ? '' : Buffer.concat(stderr).toString('utf8'),
        })
      })
    })
  }

  commandExecWrite(params: Record<string, unknown>): unknown {
    const processId = stringOr(params.processId, '')
    const child = this.commandProcesses.get(processId)
    if (!child) throw new Error(`unknown command process: ${processId}`)
    if (typeof params.deltaBase64 === 'string' && params.deltaBase64.length > 0) {
      child.stdin?.write(Buffer.from(params.deltaBase64, 'base64'))
    }
    if (params.closeStdin === true) {
      child.stdin?.end()
    }
    return {}
  }

  commandExecTerminate(params: Record<string, unknown>): unknown {
    const processId = stringOr(params.processId, '')
    const child = this.commandProcesses.get(processId)
    if (!child) throw new Error(`unknown command process: ${processId}`)
    child.kill('SIGTERM')
    return {}
  }

  processSpawn(peer: RpcPeer, params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    if (!processHandle) throw new Error('process/spawn requires processHandle')
    if (this.processHandles.has(processHandle))
      throw new Error(`process handle already active: ${processHandle}`)
    const command = commandArray(params.command)
    if (command.length === 0) throw new Error('process/spawn requires command')
    const cwd = stringOr(params.cwd, process.cwd())
    const isTty = params.tty === true
    const streamOutput = params.streamStdoutStderr === true || isTty
    const cap =
      params.outputBytesCap == null ? 1_000_000 : numberOr(params.outputBytesCap, 1_000_000)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutCapReached = false
    let stderrCapReached = false
    let exited = false

    debugLog('process.spawn.start', {
      processHandle,
      cwd,
      command,
      streamOutput,
      streamStdin: params.streamStdin === true,
      tty: isTty,
    })

    // For interactive TTY sessions (e.g. Codex App built-in terminal), spawn via pty-bridge.py
    // to allocate a real pseudo-terminal (PTY) master/slave pair with ANSI echo & ZLE line editor.
    let child: ChildProcess
    const file = fileURLToPath(import.meta.url)
    const candidates = [
      join(file, '../../../scripts/pty-bridge.py'),
      join(file, '../../scripts/pty-bridge.py'),
      join(homedir(), '.local/share/anyengine/scripts/pty-bridge.py'),
    ]
    const ptyBridge = candidates.find((c) => c && existsSync(c))
    if (isTty && ptyBridge && existsSync(ptyBridge)) {
      child = spawn('python3', [ptyBridge, ...command], {
        cwd,
        env: { ...commandEnv(params.env), TERM: 'xterm-256color' },
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      ;(child as any).__isPtyBridge = true
    } else {
      child = spawn(command[0] as string, command.slice(1), {
        cwd,
        env: commandEnv(params.env),
        stdio: 'pipe',
      })
    }
    this.processHandles.set(processHandle, child)

    const capture = (target: Buffer[], chunk: Buffer, currentBytes: number): [number, boolean] => {
      if (currentBytes >= cap) return [currentBytes, true]
      const allowed = Math.min(chunk.byteLength, cap - currentBytes)
      if (allowed > 0) target.push(chunk.subarray(0, allowed))
      return [currentBytes + allowed, allowed < chunk.byteLength]
    }

    if ((child as any).__isPtyBridge) {
      let bufferStr = ''
      child.stdout?.on('data', (chunk: Buffer | string) => {
        bufferStr += chunk.toString('utf8')
        const lines = bufferStr.split(/\r?\n/)
        bufferStr = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.stream === 'stdout') {
              this.notify(peer, {
                method: 'process/outputDelta',
                params: {
                  processHandle,
                  stream: 'stdout',
                  deltaBase64: msg.delta,
                  capReached: false,
                },
              })
            }
          } catch {}
        }
      })
    } else {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (streamOutput) {
          this.notify(peer, {
            method: 'process/outputDelta',
            params: {
              processHandle,
              stream: 'stdout',
              deltaBase64: buffer.toString('base64'),
              capReached: false,
            },
          })
        } else {
          ;[stdoutBytes, stdoutCapReached] = capture(stdout, buffer, stdoutBytes)
        }
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (streamOutput) {
          this.notify(peer, {
            method: 'process/outputDelta',
            params: {
              processHandle,
              stream: 'stderr',
              deltaBase64: buffer.toString('base64'),
              capReached: false,
            },
          })
        } else {
          ;[stderrBytes, stderrCapReached] = capture(stderr, buffer, stderrBytes)
        }
      })
    }

    // Do not impose a default timeout on interactive/streaming terminal sessions (tty or streamStdin)
    const isInteractive = isTty || params.streamStdin === true
    const defaultTimeout = isInteractive ? 0 : 60_000
    const timeoutMs =
      params.timeoutMs == null ? defaultTimeout : numberOr(params.timeoutMs, defaultTimeout)
    const timeout = timeoutMs > 0 ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : null

    child.once('error', (error) => {
      debugLog('process.spawn.error', {
        processHandle,
        error: error.message,
        code: (error as NodeJS.ErrnoException).code,
      })
      if (exited) return
      exited = true
      if (timeout) clearTimeout(timeout)
      this.processHandles.delete(processHandle)
      setImmediate(() =>
        this.notify(peer, {
          method: 'process/exited',
          params: {
            processHandle,
            exitCode: 1,
            stdout: streamOutput ? '' : Buffer.concat(stdout).toString('utf8'),
            stdoutCapReached,
            stderr: error.message,
            stderrCapReached: false,
          },
        }),
      )
    })

    child.once('close', (code, signal) => {
      if (exited) return
      exited = true
      debugLog('process.spawn.close', {
        processHandle,
        code,
        signal,
        stdoutBytes,
        stderrBytes,
        stdoutCapReached,
        stderrCapReached,
      })
      if (timeout) clearTimeout(timeout)
      this.processHandles.delete(processHandle)
      this.notify(peer, {
        method: 'process/exited',
        params: {
          processHandle,
          exitCode: code ?? 1,
          stdout: streamOutput ? '' : Buffer.concat(stdout).toString('utf8'),
          stdoutCapReached,
          stderr: streamOutput ? '' : Buffer.concat(stderr).toString('utf8'),
          stderrCapReached,
        },
      })
    })
    return {}
  }

  processWriteStdin(params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    const child = this.processHandles.get(processHandle)
    if (!child) throw new Error(`unknown process handle: ${processHandle}`)
    if (typeof params.deltaBase64 === 'string' && params.deltaBase64.length > 0) {
      if ((child as any).__isPtyBridge) {
        child.stdin?.write(JSON.stringify({ action: 'input', data: params.deltaBase64 }) + '\n')
      } else {
        child.stdin?.write(Buffer.from(params.deltaBase64, 'base64'))
      }
    }
    if (params.closeStdin === true) child.stdin?.end()
    return {}
  }

  processResizePty(params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    const child = this.processHandles.get(processHandle)
    if (child && (child as any).__isPtyBridge) {
      const size = (params.size as Record<string, unknown>) || {}
      const cols = numberOr(size.cols, 80)
      const rows = numberOr(size.rows, 24)
      child.stdin?.write(JSON.stringify({ action: 'resize', cols, rows }) + '\n')
    }
    return {}
  }

  processKill(params: Record<string, unknown>): unknown {
    const processHandle = stringOr(params.processHandle, '')
    const child = this.processHandles.get(processHandle)
    if (!child) throw new Error(`unknown process handle: ${processHandle}`)
    if ((child as any).__isPtyBridge) {
      child.stdin?.write(JSON.stringify({ action: 'kill' }) + '\n')
    }
    child.kill('SIGTERM')
    return {}
  }

  // The thread lookup stays with the server; this side only needs where to run
  // and what to run.
  shellCommand(peer: RpcPeer, input: { threadId: string; command: string; cwd: string }): unknown {
    const { threadId, command, cwd } = input
    const shell = process.env.SHELL || '/bin/sh'
    const processId = newId()
    debugLog('thread.shellCommand.start', { threadId, processId, cwd, command })
    const child = spawn(shell, ['-lc', command], { cwd, env: process.env, stdio: 'pipe' })
    this.commandProcesses.set(processId, child)
    child.stdout?.on('data', (chunk) =>
      this.notify(peer, {
        method: 'command/exec/outputDelta',
        params: {
          processId,
          stream: 'stdout',
          deltaBase64: Buffer.from(chunk).toString('base64'),
          capReached: false,
        },
      }),
    )
    child.stderr?.on('data', (chunk) =>
      this.notify(peer, {
        method: 'command/exec/outputDelta',
        params: {
          processId,
          stream: 'stderr',
          deltaBase64: Buffer.from(chunk).toString('base64'),
          capReached: false,
        },
      }),
    )
    child.once('error', (error) =>
      debugLog('thread.shellCommand.error', { threadId, processId, error: error.message }),
    )
    child.once('close', (code, signal) => {
      debugLog('thread.shellCommand.close', { threadId, processId, code, signal })
      this.commandProcesses.delete(processId)
    })
    return {}
  }

  backgroundTerminalsClean(threadId: string): unknown {
    debugLog('thread.backgroundTerminals.clean', {
      threadId,
      activeCommandProcesses: this.commandProcesses.size,
      activeProcessHandles: this.processHandles.size,
    })
    return {}
  }
}
