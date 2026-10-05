// Actual disposable owner processes; all app, engine and gate observations are synthetic.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readFlipMarker } from '../../src/control-marker.mjs'
import { realSystem } from '../../src/control-system.mjs'
import { setup } from './flip-controller.mjs'

const [home, pause] = process.argv.slice(2)
if (!home) throw new Error('home required')
const deadline = setTimeout(() => process.exit(2), 90_000)
try {
  const s = await setup({ gate: true }, home)
  const observed = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' }).processes
  s.system.processes = () => [
    ...observed().filter((p) => p.pid === process.pid || p.pid === readFlipMarker(s.root)?.pid),
    ...s.system.procs,
  ]
  for (const label of ['dev.anyengine.router', 'dev.anyengine.smoke']) {
    const plist = join(home, 'Library/LaunchAgents', `${label}.plist`)
    if (existsSync(plist)) s.system.jobs.set(label, { plist, pid: 4242 })
  }
  if (pause === 'pause')
    s.deps.doctor = async () => {
      process.send?.({ type: 'paused', marker: readFlipMarker(s.root) })
      await new Promise<void>((resolve) => process.once('message', () => resolve()))
      return { ok: true, text: 'synthetic checks' }
    }
  const code = await s.run('on')
  process.send?.({ type: 'done', code, output: s.out.join('') })
} finally {
  clearTimeout(deadline)
  process.disconnect?.()
}
