// Restore the executable bit on node-pty's spawn-helper after install.
//
// On macOS/Linux node-pty `posix_spawn`s a sibling binary called `spawn-helper`
// next to `pty.node`. node-pty 1.x publishes that helper WITHOUT the executable
// bit, so every PTY spawn fails with the unhelpful `posix_spawnp failed.` until
// it is repaired. Runs as `postinstall`; the anyengine runtime repeats the same
// repair before its first spawn in case this script never ran.
//
// Never fatal: a permission fix-up must not be able to fail an install.
import { chmod, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

if (process.platform === 'win32') process.exit(0)

const require = createRequire(import.meta.url)
let root
try {
  root = dirname(require.resolve('node-pty/package.json'))
} catch {
  process.exit(0)
}

const candidates = new Set([
  join(root, 'build', 'Release', 'spawn-helper'),
  join(root, 'build', 'Debug', 'spawn-helper'),
  join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
])

for (const helper of candidates) {
  let mode
  try {
    mode = (await stat(helper)).mode
  } catch {
    continue
  }
  if ((mode & 0o111) === 0o111) continue
  try {
    await chmod(helper, (mode & 0o7777) | 0o755)
  } catch (error) {
    process.stderr.write(
      `anyengine postinstall: could not chmod ${helper} (${error?.message ?? error})\n`,
    )
  }
}
