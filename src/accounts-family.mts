import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { AccountLedger } from './accounts-ledger.mjs'
import { identifyProcess, stopFamily } from './accounts-processes.mjs'
import type { FamilyPurpose, OwnerToken, Participant, ProcessIdentity } from './accounts-types.mjs'

export interface ManagedChild extends ChildProcess {
  nativePid?: number
}
export interface ManagedChildLifecycle {
  spawn(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ManagedChild>
  stop(child: ChildProcess): Promise<void>
  stopAll?(): Promise<void>
}
function supervisorMessage(child: ChildProcess, field: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.off('message', receive)
      child.off('error', fail)
      child.off('exit', gone)
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const gone = () => fail(new Error('Account supervisor exited before launch'))
    const receive = (value: unknown) => {
      if (!value || typeof value !== 'object' || (value as Record<string, unknown>)[field] !== true)
        return
      cleanup()
      resolve(value as Record<string, unknown>)
    }
    const timer = setTimeout(() => fail(new Error('Account family launch timed out')), 10_000)
    child.on('message', receive)
    child.once('error', fail)
    child.once('exit', gone)
  })
}
async function stopBlockedSupervisor(child: ChildProcess | null): Promise<void> {
  if (!child?.pid) return
  child.stdout?.resume()
  const exited =
    child.exitCode === null && child.signalCode === null
      ? new Promise<void>((done) => child.once('exit', () => done()))
      : Promise.resolve()
  child.kill('SIGKILL')
  await exited
  child.stdin?.destroy()
  child.stdout?.destroy()
}
export function createAccountFamily(
  ledger: AccountLedger,
  participant: Participant,
  input: { account?: string; purpose?: FamilyPurpose; owner?: OwnerToken } = {},
): ManagedChildLifecycle & { stopAll(): Promise<void> } {
  const children = new Map<
    ChildProcess,
    { id: string; identity: ProcessIdentity; exited: Promise<void> }
  >()
  const pending = new Set<Promise<ManagedChild>>()
  let stopping = false
  const stop = async (child: ChildProcess) => {
    const owned = children.get(child)
    if (!owned) throw new Error('Untracked managed Codex family')
    child.stdout?.resume()
    await stopFamily(owned.identity)
    await owned.exited
    child.stdin?.destroy()
    child.stdout?.destroy()
    ledger.releaseFamily(owned.id)
    children.delete(child)
  }
  return {
    spawn(command, args, env) {
      if (stopping) return Promise.reject(new Error('Account family stopped'))
      const result = (async () => {
        const state = ledger.state(),
          id = randomUUID()
        ledger.reserveFamily(
          {
            id,
            participant: participant.id,
            account: input.account ?? state.active,
            purpose: input.purpose ?? 'model',
            generation: state.generation,
            supervisor: participant.process,
          },
          input.owner,
        )
        let child: ManagedChild | null = null,
          granted = false
        try {
          child = spawn(
            process.execPath,
            [
              fileURLToPath(new URL('./accounts-supervisor.mjs', import.meta.url)),
              command,
              ...args,
            ],
            { env, detached: true, stdio: ['pipe', 'pipe', 'inherit', 'ipc'] },
          )
          const current = child
          const exited = new Promise<void>((done) => current.once('exit', () => done()))
          await supervisorMessage(current, 'ready')
          const identity = identifyProcess(current.pid ?? 0)
          if (!identity || identity.pid !== identity.pgid)
            throw new Error('Account supervisor group unknown')
          ledger.attachNativeFamily(id, identity)
          children.set(current, { id, identity, exited })
          const launched = supervisorMessage(current, 'launched')
          granted = true
          current.send({ run: true })
          const value = await launched
          if (!Number.isSafeInteger(value.pid))
            throw new Error('Managed Codex child identity missing')
          current.nativePid = Number(value.pid)
          return current
        } catch (error) {
          if (child && children.has(child)) await stop(child)
          else await stopBlockedSupervisor(child)
          if (!granted && !ledger.holders().find((f) => f.id === id)?.native)
            ledger.cancelUnlaunchedFamily(id, participant.id)
          throw error
        }
      })()
      pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    },
    stop,
    async stopAll() {
      stopping = true
      await Promise.allSettled([...pending])
      for (const child of [...children.keys()]) await stop(child)
    },
  }
}
