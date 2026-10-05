// This supervisor and its Codex descendants share one new process group owned
// by isolatedCommand. The caller always reaps that group, even if this process
// crashes, times out, or is killed by a broken executable. No live credentials.
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { lstatSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const caller = process.ppid
const deadline = Number(process.env.PROBE_DEADLINE)
const probe = process.env.PROBE_HOME
let reclaiming = false
function diagnostic(detail) {
  try {
    const stat = lstatSync(probe, { throwIfNoEntry: false })
    if (stat?.isDirectory() && `${stat.dev}:${stat.ino}` === process.env.PROBE_IDENTITY)
      writeFileSync(join(probe, 'cleanup-diagnostic.json'), JSON.stringify(detail))
  } catch {} // Diagnostics must never prevent owned-family termination.
}
// A caller can be terminated while blocked in spawnSync. Keep its single
// owned group supervised until it resumes, or reclaim it after reparenting.
function guard() {
  if (reclaiming) return
  // Node snapshots process.ppid at startup. Ask only about this supervisor,
  // whose PID cannot be recycled while this code is executing.
  const parent = spawnSync('/bin/ps', ['-o', 'ppid=', '-p', String(process.pid)], {
    encoding: 'utf8',
    detached: true,
    timeout: Math.max(1, Math.floor(deadline - Date.now())),
  })
  const observed =
    parent.status === 0 && /^\s*\d+\s*$/.test(parent.stdout) ? Number(parent.stdout.trim()) : null
  const abandoned = observed !== null && observed !== caller
  if (observed === caller && Date.now() < deadline - 200) return
  reclaiming = true
  diagnostic({ stage: 'start', caller, observed, abandoned })
  if (reapDescendants()) {
    diagnostic({ stage: 'joined', caller, observed, abandoned })
    if (abandoned) {
      const stat = lstatSync(probe, { throwIfNoEntry: false })
      if (stat?.isDirectory() && `${stat.dev}:${stat.ino}` === process.env.PROBE_IDENTITY)
        rmSync(probe, { recursive: true, force: true })
    }
    process.exit(1)
  }
  // Never remove a home while liveness remains unknown. Kill the whole owned
  // group as the final fail-closed action; a surviving caller also joins it.
  process.kill(-process.pid, 'SIGKILL')
}

function reapDescendants() {
  const fail = (detail) => {
    diagnostic({ stage: 'failed', detail })
    return false
  }
  while (Date.now() < deadline) {
    const listed = spawnSync(
      '/bin/ps',
      ['-o', 'pid=,pgid=,lstart=,stat=', '-g', String(process.pid)],
      {
        encoding: 'utf8',
        detached: true, // The metadata reader must not appear in the group it lists.
        timeout: Math.max(1, Math.floor(deadline - Date.now())),
      },
    )
    if (listed.status !== 0)
      return fail({
        name: 'list',
        status: listed.status,
        stdout: listed.stdout,
        stderr: listed.stderr,
      })
    const members = listed.stdout
      .trim()
      .split('\n')
      .map((line) => /^(\d+)\s+(\d+)\s+(.+?)\s+(\S+)$/.exec(line.trim()))
    if (members.some((member) => !member)) return fail({ name: 'parse', stdout: listed.stdout })
    const live = members.filter(
      (member) => Number(member[1]) !== process.pid && !member[4].startsWith('Z'),
    )
    if (!live.length) return true
    for (const member of live) {
      const current = spawnSync('/bin/ps', ['-o', 'pgid=,lstart=', '-p', member[1]], {
        encoding: 'utf8',
        detached: true,
        timeout: Math.max(1, Math.floor(deadline - Date.now())),
      })
      if (current.status === 1 && !current.stdout.trim() && !current.stderr.trim()) continue
      if (
        current.status !== 0 ||
        current.stdout.trim().replace(/\s+/g, ' ') !==
          `${process.pid} ${member[3].replace(/\s+/g, ' ')}`
      )
        return fail({
          name: 'identity',
          member,
          status: current.status,
          stdout: current.stdout,
          stderr: current.stderr,
        })
      try {
        process.kill(Number(member[1]), 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') return false
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
  return false
}
const timer = setInterval(guard, 100)
process.stdout.on('error', guard)
process.stderr.on('error', guard)
const [binary, ...args] = process.argv.slice(2)
const child = spawn('/usr/bin/sandbox-exec', ['-p', process.env.PROBE_POLICY, binary, ...args], {
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PROBE_'))),
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => process.stdout.write(chunk))
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
try {
  const [code] = await once(child, 'close')
  guard()
  process.exitCode = code ?? 1
} catch (error) {
  console.error(String(error))
  process.exitCode = 1
} finally {
  clearInterval(timer)
}
