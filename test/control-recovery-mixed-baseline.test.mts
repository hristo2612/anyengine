import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { sameState, stateAt } from '../src/control-layer-state.mjs'
import { POPPED, recoveryPaths } from '../src/control-layers.mjs'
import { run, setup } from './helpers/recovery-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

for (const kind of ['file', 'symlink', 'absent'] as const) {
  test(`Bash last-good retries a mixed recorded ${kind} baseline, rejects unknown edits, then completes Off`, async () => {
    const s = await setup(true)
    const target = join(s.home, 'partially-restored')
    const current = join(s.home, 'current')
    const initial = () => {
      try {
        unlinkSync(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (kind === 'file') writeFileSync(target, 'initial bytes\n', { mode: 0o640 })
      if (kind === 'symlink') symlinkSync("initial ' library", target)
    }
    initial()
    symlinkSync('initial-library', current)
    const beforeTarget = stateAt(target)
    const beforeCurrent = stateAt(current)
    if (kind === 'symlink') s.writer.writeSymlink(target, "last-good ' library")
    else s.writer.writeFile(target, 'last-good bytes\n', 0o600)
    s.writer.writeSymlink(current, 'last-good-library')
    const goodTarget = stateAt(target)
    const goodCurrent = stateAt(current)
    s.writer.beginUpgrade()
    if (kind === 'symlink') s.writer.writeSymlink(target, 'new-library')
    else s.writer.writeFile(target, 'new bytes\n', 0o644)
    s.writer.writeSymlink(current, 'new-library')

    unlinkSync(target)
    if (kind === 'symlink') symlinkSync('operator-library', target)
    else writeFileSync(target, 'operator bytes\n', { mode: 0o644 })
    const operator = stateAt(target)
    const journal = enginePaths(s.root).layers
    const evidence = readFileSync(journal)
    const refused = run(s, '--last-good', '--no-restart')
    assert.notEqual(refused.status, 0, refused.stdout + refused.stderr)
    assert.match(refused.stderr, /changed since AnyEngine wrote it/)
    assert.ok(sameState(stateAt(target), operator), 'unknown operator state is preserved')
    assert.ok(sameState(stateAt(current), goodCurrent), 'independent target reached last-good')
    assert.deepEqual(readFileSync(journal), evidence, 'failed last-good retains checkpoint bytes')
    assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))

    // Reproduce fallback restoring only one target to its recorded initial state.
    initial()
    assert.ok(sameState(stateAt(target), beforeTarget))
    const retried = run(s, '--last-good', '--no-restart')
    assert.equal(retried.status, 0, retried.stdout + retried.stderr)
    assert.ok(sameState(stateAt(target), goodTarget), 'initial state can return to last-good')
    assert.ok(sameState(stateAt(current), goodCurrent))
    assert.deepEqual(readFileSync(journal), evidence, 'last-good retains initial authority')
    assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
    assert.ok(existsSync(recoveryPaths(s.root).entry))

    const off = run(s, '--no-restart')
    assert.equal(off.status, 0, off.stdout + off.stderr)
    assert.ok(sameState(stateAt(target), beforeTarget), 'broad Off restores initial kind and mode')
    assert.ok(sameState(stateAt(current), beforeCurrent))
    assert.ok(!existsSync(journal), 'terminal Off retires the journal')
    assert.ok(existsSync(recoveryPaths(s.root).entry), 'private recovery remains available')
  })
}
