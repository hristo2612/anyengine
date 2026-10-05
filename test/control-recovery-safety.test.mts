import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { parse } from 'smol-toml'
import { enginePaths } from '../src/anyengine-config.mjs'
import { insertTopLevelLine, topLevelKeys } from '../src/codex-config-toml.mjs'
import { adoptM0, POPPED, readLayers, recoveryPaths, writeLayers } from '../src/control-layers.mjs'
import { publishRecovery, shellQuote } from '../src/control-scripts.mjs'
import { required, run, setup } from './helpers/recovery-home.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

function shared(
  s: Awaited<ReturnType<typeof setup>>,
  text: string,
  pick: string | Buffer | null = '{"model":"opus"}',
) {
  const target = join(s.codexHome, 'config.toml'),
    pickFile = join(s.codexHome, 'app-model-pick.json')
  writeFileSync(target, text)
  if (pick !== null) writeFileSync(pickFile, pick)
  writeFileSync(join(s.writer.layer.rollbackDir, 'config.bak'), 'model = "sonnet"\n')
  s.writer.layer.sharedConfig = {
    target,
    pickFile,
    backup: 'config.bak',
    removed: [{ key: 'model', value: 'sonnet', index: 0, text: 'model = "sonnet"' }],
  }
  writeLayers(s.root, { version: 1, layers: [s.writer.layer] })
  publishRecovery(s.options)
  return { target, pickFile }
}
const ok = (r: ReturnType<typeof run>) => assert.equal(r.status, 0, r.stdout + r.stderr)

for (const [label, text, valid] of [
  ['table then array', '[a]\nx = 1\n[[a]]\ny = 2\n', false],
  ['array then table', '[[a]]\nx = 1\n[a]\ny = 2\n', false],
  ['implicit parent then array', '[a.b]\nx = 1\n[[a]]\ny = 2\n', false],
  ['dotted namespace then table', '[a]\nx.y = 1\n[a.x]\nz = 2\n', false],
  ['repeated array', '[[a]]\nx = 1\n[[a]]\nx = 2\n', true],
  ['distinct tables', '[a]\nx = 1\n[[b]]\nx = 2\n[c]\nx = 3\n', true],
  ['implicit then explicit parent', '[a.b]\nx = 1\n[a]\ny = 2\n', true],
] as const) {
  test(`TOML namespace ownership: ${label}`, async () => {
    if (valid) assert.doesNotThrow(() => parse(text))
    else assert.throws(() => parse(text))
    const s = await setup(),
      files = shared(s, text),
      journal = enginePaths(s.root).layers,
      evidence = readFileSync(journal),
      pick = readFileSync(files.pickFile)
    const r = run(s, '--no-restart')
    if (valid) {
      ok(r)
      assert.equal(readFileSync(files.target, 'utf8'), `model = "opus"\n${text}`)
      assert.ok(!existsSync(files.pickFile))
      assert.ok(!existsSync(journal))
    } else {
      assert.notEqual(r.status, 0, r.stdout + r.stderr)
      assert.equal(readFileSync(files.target, 'utf8'), text)
      assert.deepEqual(readFileSync(files.pickFile), pick)
      assert.deepEqual(readFileSync(journal), evidence)
      assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
    }
  })
}

test('supported TOML Node/Bash parity preserves multiline literals, quoted keys, arrays/tables and CRLF', async () => {
  for (const text of [
    'note = """\nmodel = "inert"\n"""\n[[projects]]\nname = "x"\n',
    "note = '''\nmodel = 'inert'\n'''\n[features]\nx = true\n",
    'allowed = ["x", "y"]\r\n[[projects]]\r\nmodel = "nested"\r\n',
    '"model" = "gpt-current" # newer\r\n[features]\r\nx = true\r\n',
    "'model' = 'gpt-newer'\n",
  ]) {
    const s = await setup(),
      files = shared(s, text)
    ok(run(s, '--no-restart'))
    const expected = topLevelKeys(text).includes('model')
      ? text
      : insertTopLevelLine(text, 0, 'model = "opus"')
    assert.equal(readFileSync(files.target, 'utf8'), expected)
    assert.ok(!existsSync(files.pickFile))
  }
})

test('unsupported TOML and corrupt UTF-8 picks preserve bytes and evidence', async () => {
  for (const [text, pick] of [
    ['text = """unfinished\nmodel = "false"\n', '{"model":"opus"}'],
    ['model = 123\n', '{"model":"opus"}'],
    ['[a]\nx = 1\n[a.x]\ny = 2\n', '{"model":"opus"}'],
    [
      'model = "gpt-newer"\n',
      Buffer.from([123, 34, 109, 111, 100, 101, 108, 34, 58, 34, 111, 0xff, 34, 125]),
    ],
    ['fine = true\n', '{"model":'],
    ['fine = true\n', '{"model":"opus","unknown":"x"}'],
  ] as Array<[string, string | Buffer]>) {
    const s = await setup(),
      files = shared(s, text, pick),
      original = readFileSync(files.pickFile)
    const r = run(s, '--no-restart')
    assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.equal(readFileSync(files.target, 'utf8'), text)
    assert.deepEqual(readFileSync(files.pickFile), original)
    assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
  }
})

test('invalid UTF-8 cache is retained; valid U+FFFD cache and absent cache are accepted', async () => {
  for (const content of [
    Buffer.from('{"models":[{"slug":"replacement-�"}]}'),
    null,
    Buffer.from('{"models":[{"slug":"x","description":"via AnyEngine"}]}'),
  ]) {
    const s = await setup()
    s.writer.writeFile(join(s.home, 'target'), 'x', 0o600)
    const cache = join(s.codexHome, 'models_cache.json')
    if (content) writeFileSync(cache, content)
    ok(run(s, '--no-restart'))
    if (content?.includes('via AnyEngine'))
      assert.deepEqual(readFileSync(join(s.writer.layer.rollbackDir, 'models_cache.json')), content)
  }
  const s = await setup()
  s.writer.writeFile(join(s.home, 'target'), 'x', 0o600)
  const cache = join(s.codexHome, 'models_cache.json'),
    corrupt = Buffer.from('{"models":[{"slug":"X","description":"via AnyEngine"}]}')
  corrupt[corrupt.indexOf('X')] = 0xff
  writeFileSync(cache, corrupt)
  assert.notEqual(run(s, '--no-restart').status, 0)
  assert.deepEqual(readFileSync(cache), corrupt)
  assert.ok(existsSync(enginePaths(s.root).layers))
})

test('invalid POPPED, backup hash, directory evidence and journal shapes block all target changes', async () => {
  for (const damage of ['popped', 'backup', 'directory', 'version']) {
    const s = await setup(),
      target = join(s.home, 'target')
    writeFileSync(target, 'before')
    s.writer.writeFile(target, 'after', 0o600)
    const l = s.writer.layer,
      journal = enginePaths(s.root).layers
    if (damage === 'popped') symlinkSync('/missing', join(l.rollbackDir, POPPED))
    if (damage === 'backup')
      writeFileSync(join(l.rollbackDir, required(required(l.changes[0]).backup)), 'corrupt')
    if (damage === 'directory') {
      const other = `${l.rollbackDir}-moved`
      spawnSync('/bin/mv', [l.rollbackDir, other])
      symlinkSync(other, l.rollbackDir)
    }
    if (damage === 'version')
      writeFileSync(journal, readFileSync(journal, 'utf8').replace('"version": 1', '"version": 9'))
    const bytes = readFileSync(journal)
    assert.notEqual(run(s, '--no-restart').status, 0)
    assert.equal(readFileSync(target, 'utf8'), 'after')
    assert.deepEqual(readFileSync(journal), bytes)
  }
})

test('M0 router-only selects router; full off restores native and partial rc keeps operator edits plus durable retry', async () => {
  for (const edited of [false, true]) {
    const s = await setup()
    const adopted = adoptM0(s.root, s.home, 'm0')
    assert.ok(adopted && 'layer' in adopted)
    writeLayers(s.root, { version: 1, layers: [adopted.layer] })
    s.writer.writeFile(join(s.home, 'bin', 'codex'), 'router shim\n', 0o755)
    if (edited)
      writeFileSync(
        join(s.home, '.zshrc'),
        `${readFileSync(join(s.home, '.zshrc'), 'utf8')}alias user='ls'\n`,
      )
    ok(run(s, '--router-only', '--no-restart'))
    assert.deepEqual(
      readLayers(s.root).layers.map((l) => l.name),
      ['adapter'],
    )
    const r = run(s, '--no-restart')
    if (edited) {
      assert.notEqual(r.status, 0, r.stdout + r.stderr)
      assert.match(readFileSync(join(s.home, '.zshrc'), 'utf8'), /alias user/)
      assert.match(readFileSync(join(s.home, 'bin', 'codex'), 'utf8'), /m0/)
      ok(run(s, '--no-restart'))
    } else ok(r)
    assert.ok(!existsSync(enginePaths(s.root).layers))
  }
})

test('cache conflicting backup and real config/install/link/removal failures stay nonterminal', async () => {
  for (const op of ['install', 'link', 'remove', 'config', 'cache']) {
    const s = await setup()
    const target = join(s.home, 'target')
    if (op === 'install') writeFileSync(target, 'before')
    if (op === 'link') symlinkSync('old', target)
    if (op === 'config') shared(s, 'x = true\n')
    else if (op === 'link') s.writer.writeSymlink(target, 'new')
    else s.writer.writeFile(target, 'after', 0o600)
    if (op === 'cache') {
      writeFileSync(
        join(s.codexHome, 'models_cache.json'),
        '{"models":[{"slug":"opus","description":"via AnyEngine"}]}',
      )
      writeFileSync(join(s.writer.layer.rollbackDir, 'models_cache.json'), 'partial')
    } else {
      const entry = recoveryPaths(s.root).entry
      const from =
        op === 'install'
          ? '/usr/bin/install'
          : op === 'link'
            ? '/bin/ln'
            : op === 'config'
              ? '/bin/mv'
              : '/bin/rm -f "$target"'
      const to = op === 'remove' ? '/usr/bin/false' : s.stub('failure', 'exit 7')
      writeFileSync(
        entry,
        readFileSync(entry, 'utf8').replaceAll(from, op === 'remove' ? to : shellQuote(to)),
      )
    }
    const r = run(s, '--no-restart')
    assert.notEqual(r.status, 0, `${op}: ${r.stdout}${r.stderr}`)
    assert.ok(existsSync(enginePaths(s.root).layers), op)
    assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)), op)
  }
})

test('opaque SQLite files and sidecars remain byte/inode stable throughout recovery', async () => {
  const s = await setup(),
    paths = ['config.sqlite', 'config.sqlite-wal', 'config.sqlite-shm'].map((p) => join(s.root, p))
  for (const p of paths) writeFileSync(p, 'opaque fixture')
  const stamps = paths.map((p) => lstatSync(p).ino)
  s.writer.writeFile(join(s.home, 'target'), 'after', 0o600)
  ok(run(s, '--no-restart'))
  assert.deepEqual(
    paths.map((p) => lstatSync(p).ino),
    stamps,
  )
  // Only inert test fixture bytes are checked; production recovery never opens them.
  assert.deepEqual(
    paths.map((p) => readFileSync(p, 'utf8')),
    paths.map(() => 'opaque fixture'),
  )
})
