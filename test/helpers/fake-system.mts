import { join } from 'node:path'
import type { ExecResult, ProcessInfo, System } from '../../src/control-system.mjs'

// In-memory Mac actions with explicit failure controls. Failed actions retain
// app/job state so callers cannot mistake unknown or refused work for success.
export interface FakeSystem extends System {
  calls: string[]
  version: string | null
  versionAfterRelaunch: string | null
  running: boolean
  runningError: Error | null
  processError: Error | null
  openError: Error | null
  quitError: Error | null
  notifyError: Error | null
  quitResult: boolean
  jobs: Map<string, { plist: string; pid: number | null }>
  procs: ProcessInfo[]
  notifications: Array<{ title: string; message: string }>
  execs: Map<string, ExecResult>
  onOpen: (() => void) | null
}

export function fakeSystem(home: string): FakeSystem {
  const fake: FakeSystem = {
    home,
    app: join(home, 'Applications', 'ChatGPT.app'),
    calls: [],
    version: '26.928.20755',
    versionAfterRelaunch: null,
    running: true,
    runningError: null,
    processError: null,
    openError: null,
    quitError: null,
    notifyError: null,
    quitResult: true,
    jobs: new Map(),
    procs: [],
    notifications: [],
    execs: new Map(),
    onOpen: null,
    now: () => new Date(Date.parse('2026-10-01T00:00:00Z') + fake.calls.length * 60_000),
    exec(command, args) {
      fake.calls.push(`exec ${command} ${args.join(' ')}`)
      return fake.execs.get(`${command} ${args.join(' ')}`) ?? { status: 0, stdout: '', stderr: '' }
    },
    appVersion: () => fake.version,
    appExecutable: () => join(fake.app, 'Contents/MacOS/ChatGPT'),
    appRunning: () => {
      if (fake.runningError) throw fake.runningError
      return fake.running
    },
    quitApp() {
      fake.calls.push('quitApp')
      if (fake.quitError) throw fake.quitError
      if (fake.runningError) throw fake.runningError
      if (!fake.quitResult) return false
      fake.running = false
      return true
    },
    openApp() {
      fake.calls.push('openApp')
      if (fake.openError) throw fake.openError
      fake.running = true
      if (fake.versionAfterRelaunch) fake.version = fake.versionAfterRelaunch
      fake.onOpen?.()
    },
    launchctl(args) {
      fake.calls.push(`launchctl ${args.join(' ')}`)
      const configured = fake.execs.get(`launchctl ${args.join(' ')}`)
      if (configured) return configured
      const [verb, target, plist] = args
      const label = (target ?? '').split('/').pop() ?? ''
      if (verb === 'print') {
        const job = fake.jobs.get(label)
        return job
          ? { status: 0, stdout: `pid = ${job.pid ?? 0}\n`, stderr: '' }
          : { status: 113, stdout: '', stderr: '' }
      }
      if (verb === 'bootstrap' && plist)
        fake.jobs.set(
          plist
            .split('/')
            .pop()
            ?.replace(/\.plist$/, '') ?? '',
          { plist, pid: 4242 },
        )
      if (verb === 'bootout') fake.jobs.delete(label)
      return { status: 0, stdout: '', stderr: '' }
    },
    processes: () => {
      if (fake.processError) throw fake.processError
      return fake.procs
    },
    notify(title, message) {
      if (fake.notifyError) throw fake.notifyError
      fake.notifications.push({ title, message })
    },
    sleep: async () => {},
    spawnDetached: (argv, log) => {
      fake.calls.push(`spawnDetached ${argv.join(' ')} ${log}`)
      return 4242
    },
  }
  return fake
}
