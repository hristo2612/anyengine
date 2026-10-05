// Disposable caller exits immediately; the actual flip-run child must survive.
import { realSystem } from '../../src/control-system.mjs'

const [log, id] = process.argv.slice(2)
if (!log || !id) throw new Error('log and id required')
const pid = realSystem().spawnDetached(
  [process.execPath, 'dist/src/adapter.mjs', 'flip-run', id, 'restart', '--yes'],
  log,
)
process.send?.({ pid }, () => process.disconnect?.())
