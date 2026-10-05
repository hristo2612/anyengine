import { existsSync, writeFileSync } from 'node:fs'
import { takeFlipLock } from '../../src/control-flip-lock.mjs'
import { realSystem } from '../../src/control-system.mjs'

const [root, barrier] = process.argv.slice(2)
if (!root) throw new Error('root required')
const system = realSystem({ ...process.env, ANYENGINE_PS: '/bin/ps' })
const processes = system.processes
let inspections = 0
system.processes = () => {
  const result = processes()
  if (barrier && ++inspections === 3) {
    writeFileSync(`${barrier}.ready`, '')
    const end = Date.now() + 20_000
    while (!existsSync(`${barrier}.go`)) {
      if (Date.now() > end) throw new Error('barrier deadline')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  return result
}
let lock: ReturnType<typeof takeFlipLock> | undefined
process.on('message', (command) => {
  try {
    if (command === 'take') {
      lock = takeFlipLock(root, system)
      process.send?.({ type: 'taken', ok: lock.ok })
    } else if (command === 'release') {
      if (lock?.ok) lock.release()
      process.send?.({ type: 'released' }, () => process.exit(0))
    }
  } catch (error) {
    process.send?.({ type: 'error', error: String(error) }, () => process.exit(1))
  }
})
process.send?.({ type: 'ready' })
