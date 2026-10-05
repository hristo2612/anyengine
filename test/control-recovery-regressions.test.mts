import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import { LayerWriter, POPPED, recoveryPaths } from '../src/control-layers.mjs'
import { publicRecoveryScript, publishRecovery, shellQuote } from '../src/control-scripts.mjs'
import { configure, required, run, setup } from './helpers/recovery-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

for (const kind of ['file', 'symlink', 'absent'] as const) {
  for (const retry of [false, true]) {
    test(`journaled public ${kind} survives full ladder retirement${retry ? ' retry' : ''}`, async () => {
      const s = await setup(true),
        publicEntry = join(s.root, 'bin', 'anyengine-off'),
        entry = recoveryPaths(s.root).entry,
        journal = enginePaths(s.root).layers,
        original = '#!/bin/bash\necho original launcher\n',
        link = "../original ' ü"
      rmSync(publicEntry)
      if (kind === 'file') writeFileSync(publicEntry, original, { mode: 0o700 })
      if (kind === 'symlink') symlinkSync(link, publicEntry)
      const adapter = new LayerWriter(s.root, null, 'adapter', 'adapter', () =>
        publishRecovery(s.options),
      )
      adapter.writeFile(publicEntry, 'adapter launcher\n', 0o755)
      s.writer.writeFile(publicEntry, publicRecoveryScript(s.root), 0o755)
      const script = readFileSync(entry, 'utf8')
      if (retry) {
        const fail = s.stub(
          'journal-removal',
          `case "$*" in *state/layers.json*) exit 9;; esac\nexec /bin/rm "$@"`,
        )
        writeFileSync(entry, script.replaceAll('/bin/rm', shellQuote(fail)))
        const interrupted = run(s, '--no-restart')
        assert.notEqual(interrupted.status, 0)
        assert.match(interrupted.stderr, /journal removal failed/)
        assert.ok(existsSync(journal))
        assert.ok(existsSync(join(adapter.layer.rollbackDir, POPPED)))
        assert.ok(existsSync(join(s.writer.layer.rollbackDir, POPPED)))
        writeFileSync(entry, script)
      }
      const result = run(s, '--no-restart')
      assert.equal(result.status, 0, result.stdout + result.stderr)
      if (kind === 'file') {
        assert.equal(readFileSync(publicEntry, 'utf8'), original)
        assert.equal(lstatSync(publicEntry).mode & 0o7777, 0o700)
      } else if (kind === 'symlink') assert.equal(readlinkSync(publicEntry), link)
      else assert.throws(() => lstatSync(publicEntry), { code: 'ENOENT' })
      assert.ok(!existsSync(journal))
      assert.ok(existsSync(entry))
      const before = existsSync(s.calls) ? readFileSync(s.calls) : null
      assert.equal(run(s).status, 0)
      assert.deepEqual(existsSync(s.calls) ? readFileSync(s.calls) : null, before)
    })
  }
}

for (const damage of [
  'edit',
  'mode',
  'link',
  'wrapper',
  'absent',
  'inaccessible',
  'blob',
] as const) {
  test(`all-POPPED public baseline ${damage} refuses retirement and remains retryable`, async () => {
    const s = await setup(),
      publicEntry = join(s.root, 'bin', 'anyengine-off'),
      entry = recoveryPaths(s.root).entry,
      journal = enginePaths(s.root).layers,
      original = 'original launcher\n'
    writeFileSync(publicEntry, original)
    chmodSync(publicEntry, 0o700)
    s.writer.writeFile(publicEntry, publicRecoveryScript(s.root), 0o755)
    const script = readFileSync(entry, 'utf8'),
      fail = s.stub(
        'journal-removal',
        `case "$*" in *state/layers.json*) exit 9;; esac\nexec /bin/rm "$@"`,
      )
    writeFileSync(entry, script.replaceAll('/bin/rm', shellQuote(fail)))
    const interrupted = run(s, '--no-restart')
    assert.notEqual(interrupted.status, 0)
    assert.match(interrupted.stderr, /journal removal failed/)
    assert.ok(existsSync(join(s.writer.layer.rollbackDir, POPPED)))
    writeFileSync(entry, script)
    const evidence = readFileSync(journal),
      backup = join(
        s.writer.layer.rollbackDir,
        required(required(s.writer.layer.changes[0]).backup),
      ),
      bytes = readFileSync(backup)
    if (damage === 'edit') writeFileSync(publicEntry, 'later operator edit\n')
    if (damage === 'mode') chmodSync(publicEntry, 0o755)
    if (damage === 'link') {
      rmSync(publicEntry)
      symlinkSync('unknown-original', publicEntry)
    }
    if (damage === 'wrapper') {
      writeFileSync(publicEntry, publicRecoveryScript(s.root))
      chmodSync(publicEntry, 0o755)
    }
    if (damage === 'absent') rmSync(publicEntry)
    if (damage === 'inaccessible') chmodSync(join(s.root, 'bin'), 0)
    if (damage === 'blob') writeFileSync(backup, 'corrupt')
    try {
      assert.notEqual(run(s, '--no-restart').status, 0)
      assert.deepEqual(readFileSync(journal), evidence)
      if (damage === 'edit')
        assert.equal(readFileSync(publicEntry, 'utf8'), 'later operator edit\n')
    } finally {
      chmodSync(join(s.root, 'bin'), 0o700)
    }
    writeFileSync(backup, bytes)
    try {
      unlinkSync(publicEntry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    writeFileSync(publicEntry, original)
    chmodSync(publicEntry, 0o700)
    const retry = run(s, '--no-restart')
    assert.equal(retry.status, 0, retry.stdout + retry.stderr)
    assert.ok(!existsSync(journal))
    assert.equal(readFileSync(publicEntry, 'utf8'), original)
  })
}

test('a tracked public launcher edited after publication retains its original evidence', async () => {
  const s = await setup(),
    publicEntry = join(s.root, 'bin', 'anyengine-off')
  writeFileSync(publicEntry, 'original launcher\n')
  s.writer.writeFile(publicEntry, publicRecoveryScript(s.root), 0o755)
  writeFileSync(publicEntry, 'changed after publication\n')
  const journal = enginePaths(s.root).layers,
    evidence = readFileSync(journal)
  assert.notEqual(run(s, '--no-restart').status, 0)
  assert.equal(readFileSync(publicEntry, 'utf8'), 'changed after publication\n')
  assert.deepEqual(readFileSync(journal), evidence)
  assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
})

test('real successful job stop is resumable after a later failure without repeating a now-absent bootout', async () => {
  const s = await setup(),
    once = join(s.home, 'stopped'),
    cache = join(s.codexHome, 'models_cache.json')
  s.writer.addJob('dev.anyengine.router')
  s.env.ANYENGINE_LAUNCHCTL = s.stub(
    'once',
    `if [ "$1" = print ]; then
  case "$2" in gui/*/dev.anyengine.router)
    if [ -e ${shellQuote(once)} ]; then printf 'Bad request.\\nCould not find service "dev.anyengine.router" in domain for user gui: %s\\n' "$(id -u)" >&2; exit 113; fi;;
  esac
  exit 0
fi
if [ -e ${shellQuote(once)} ]; then exit 9; fi
: > ${shellQuote(once)}`,
  )
  configure(s)
  writeFileSync(cache, 'malformed')
  assert.notEqual(run(s, '--no-restart').status, 0)
  writeFileSync(cache, '{"models":[]}')
  const r = run(s, '--no-restart')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('a failed rc hunk output allocation gates all dependent file restoration', async () => {
  const s = await setup(),
    rc = join(s.home, '.zshrc'),
    target = join(s.home, 'dependent')
  writeFileSync(rc, 'old\n')
  s.writer.writeFile(target, 'keep me', 0o600)
  s.writer.writeFile(rc, 'new\n', 0o644)
  writeFileSync(rc, 'new\nuser edit\n')
  const entry = recoveryPaths(s.root).entry
  const allocator = s.stub(
    'allocation',
    `case "$*" in *zshrc*) exit 3;; esac\nexec /usr/bin/mktemp "$@"`,
  )
  writeFileSync(
    entry,
    readFileSync(entry, 'utf8').replaceAll('/usr/bin/mktemp', shellQuote(allocator)),
  )
  assert.notEqual(run(s, '--no-restart').status, 0)
  assert.equal(readFileSync(target, 'utf8'), 'keep me')
  assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
})

test('partial publication never clears a newly published layer while using an earlier stable entry', async () => {
  const s = await setup(),
    entry = recoveryPaths(s.root).entry,
    old = readFileSync(entry),
    target = join(s.home, 'new-layer-target')
  s.writer.writeFile(target, 'new', 0o600)
  writeFileSync(entry, old)
  const r = run(s, '--no-restart')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!existsSync(target))
})

test('operator-edited public recovery launcher is retained with journal and private entry', async () => {
  const s = await setup(),
    publicEntry = join(s.root, 'bin', 'anyengine-off')
  s.writer.writeFile(join(s.home, 'target'), 'new', 0o600)
  writeFileSync(publicEntry, 'operator content')
  assert.notEqual(run(s, '--no-restart').status, 0)
  assert.equal(readFileSync(publicEntry, 'utf8'), 'operator content')
  assert.ok(existsSync(enginePaths(s.root).layers))
  assert.ok(existsSync(recoveryPaths(s.root).entry))
})

test('journal legitimate encoded replacement character remains valid', async () => {
  const s = await setup(),
    target = join(s.home, 'valid-�')
  s.writer.writeFile(target, 'new', 0o600)
  const r = run(s, '--no-restart')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('inaccessible ancestor is unknown, never an already-absent target', async () => {
  const s = await setup(),
    dir = join(s.home, 'sealed'),
    target = join(dir, 'target')
  mkdirSync(dir)
  s.writer.writeFile(target, 'new', 0o600)
  const { chmodSync } = await import('node:fs')
  chmodSync(dir, 0)
  try {
    const r = run(s, '--no-restart')
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.ok(existsSync(enginePaths(s.root).layers))
    assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
  } finally {
    chmodSync(dir, 0o700)
  }
})

test('pre-writer publication preserves unknown public launcher bytes', async () => {
  const s = await setup(),
    publicEntry = join(s.root, 'bin', 'anyengine-off')
  writeFileSync(publicEntry, 'original operator launcher')
  publishRecovery(s.options)
  assert.equal(readFileSync(publicEntry, 'utf8'), 'original operator launcher')
})

test('ambient tool and wait overrides cannot change immutable inspection authority', async () => {
  const s = await setup()
  s.writer.addJob('dev.anyengine.router')
  s.env.ANYENGINE_PGREP = s.stub('down-spoof', 'exit 1')
  required(s.options.commands).pgrep = s.stub('true-running', 'echo 123')
  publishRecovery(s.options)
  const r = run(s, '--no-restart')
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  assert.ok(!existsSync(s.calls))
})

test('unknown launchctl domain/permission/113 output never proves job absence', async () => {
  for (const failure of [
    'exit 9',
    'echo "permission denied" >&2; exit 113',
    `printf 'Bad request.\\nCould not find service "dev.anyengine.router" in domain for user gui: %s\\n' "$(id -u)" >&2; exit 113`,
  ]) {
    const s = await setup()
    s.writer.addJob('dev.anyengine.router')
    s.env.ANYENGINE_LAUNCHCTL = s.stub('bad-inspection', failure)
    configure(s)
    const r = run(s, '--no-restart')
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
  }
})

test('one failed rc gates dependencies even when a second rc restores successfully', async () => {
  const s = await setup(),
    first = join(s.home, '.zshrc'),
    second = join(s.home, '.bash_profile'),
    target = join(s.home, 'dependent')
  writeFileSync(first, 'before\n')
  writeFileSync(second, 'before\n')
  s.writer.writeFile(target, 'keep', 0o600)
  s.writer.writeFile(first, 'after\n', 0o644)
  s.writer.writeFile(second, 'after\n', 0o644)
  writeFileSync(second, 'after\noperator\n')
  assert.notEqual(run(s, '--no-restart').status, 0)
  assert.equal(readFileSync(target, 'utf8'), 'keep')
})

test('failed public-wrapper removal retains journal and private retry', async () => {
  const s = await setup()
  s.writer.writeFile(join(s.home, 'target'), 'new', 0o600)
  const entry = recoveryPaths(s.root).entry
  const original = readFileSync(entry, 'utf8')
  const fail = s.stub(
    'public-removal',
    `case "$*" in *bin/anyengine-off*) exit 9;; esac\nexec /bin/rm "$@"`,
  )
  writeFileSync(entry, original.replaceAll('/bin/rm', shellQuote(fail)))
  const r = run(s, '--no-restart')
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  assert.ok(existsSync(enginePaths(s.root).layers))
  assert.ok(existsSync(entry))
})

test('Node-invalid BOM-prefixed journal is refused with exact bytes retained', async () => {
  const s = await setup(),
    target = join(s.home, 'target')
  s.writer.writeFile(target, 'new', 0o600)
  const path = enginePaths(s.root).layers,
    bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(path)])
  writeFileSync(path, bytes)
  const r = run(s, '--no-restart')
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(readFileSync(path), bytes)
  assert.equal(readFileSync(target, 'utf8'), 'new')
})

test('terminal private re-entry is idle, while a missing-journal parent error refuses', async () => {
  const s = await setup()
  s.writer.writeFile(join(s.home, 'target'), 'new', 0o600)
  assert.equal(run(s, '--no-restart').status, 0)
  const before = existsSync(s.calls) ? readFileSync(s.calls) : null
  const r = run(s)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(existsSync(s.calls) ? readFileSync(s.calls) : null, before)
  assert.ok(existsSync(recoveryPaths(s.root).entry))
  assert.ok(existsSync(recoveryPaths(s.root).instructions))
  chmodSync(join(s.root, 'state'), 0)
  try {
    assert.notEqual(run(s, '--no-restart').status, 0)
  } finally {
    chmodSync(join(s.root, 'state'), 0o700)
  }
})
