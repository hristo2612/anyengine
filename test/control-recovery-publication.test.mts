import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { runOff } from '../src/control-flip.mjs'
import { executingLib } from '../src/control-flip-options.mjs'
import { prepareRecovery } from '../src/control-flip-recovery.mjs'
import { digest } from '../src/control-layer-state.mjs'
import { type LayerFile, POPPED, readLayers, writeLayers } from '../src/control-layers.mjs'
import { recoveryEvidence } from '../src/control-recovery-evidence.mjs'
import { publicationPath } from '../src/control-recovery-publication.mjs'
import { publicationJournalPath } from '../src/control-recovery-terminal.mjs'
import {
  settleTerminalRecovery,
  validateRetainedRecovery,
} from '../src/control-recovery-validation.mjs'
import { offScript, publishRecovery, shellQuote } from '../src/control-scripts.mjs'
import { type Retained, retained, tree } from './helpers/retained-recovery.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)
type Boundary =
  | 'before-entry'
  | 'after-entry'
  | 'before-settlement'
  | 'after-settlement'
  | 'after-receipt'
// Exit from the real filesystem operations in a separate publisher process.
// No finally handler can finish publication or repair attribution after exit.
const interruptPublisher = `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const [optionsText, boundary, moduleUrl] = process.argv.slice(1)
const options = JSON.parse(optionsText)
const entry = options.root + '/recovery/anyengine-off'
const journal = options.root + '/state/layers.json'
const intent = options.root + '/recovery/publication.json'
const rename = fs.renameSync
fs.renameSync = (from, to) => {
  const pending = fs.existsSync(intent)
  if ((boundary === 'before-entry' && to === entry) ||
      (boundary === 'after-entry' && to === options.root + '/RECOVER.txt') ||
      (boundary === 'before-settlement' && to === journal && pending)) process.exit(73)
  rename(from, to)
  if (boundary === 'after-settlement' && to === journal && pending) process.exit(73)
}
const link = fs.linkSync
fs.linkSync = (from, to) => {
  link(from, to)
  if (boundary === 'after-receipt' && from === intent) process.exit(73)
}
syncBuiltinESMExports()
const { publishRecovery } = await import(moduleUrl)
publishRecovery(options)
throw Error('interruption boundary was not reached')
`
function interrupt(s: Retained, boundary: Boundary) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      interruptPublisher,
      JSON.stringify(s.options),
      boundary,
      new URL('../src/control-scripts.mjs', import.meta.url).href,
    ],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: s.home } },
  )
  assert.equal(result.status, 73, result.stderr || 'publisher must exit at the requested boundary')
  const path = publicationPath(s.root)
  assert.ok(existsSync(path), 'write-ahead intent must survive publisher exit')
  return readFileSync(path)
}
const offOptions = {
  yes: true,
  waitQuietMinutes: 0,
  force: false,
  foreground: true,
  follow: false,
  routerOnly: false,
  noRestart: true,
}
function receipts(s: Retained): Buffer[] {
  const dir = join(s.paths.directory, 'publications')
  return readdirSync(dir).map((name) => readFileSync(join(dir, name)))
}

for (const boundary of [
  'before-entry',
  'after-entry',
  'before-settlement',
  'after-settlement',
  'after-receipt',
] as const)
  test(`publication process exit ${boundary}: retry Node Off succeeds and retains both authorities`, async () => {
    const s = await retained()
    const oldEntry = readFileSync(s.paths.entry)
    const oldRecovery = readLayers(s.root).recovery
    assert.ok(oldRecovery)
    const oldPins = [...oldRecovery.pinnedLibs]
    const firstLayer = readLayers(s.root).layers[0]
    assert.ok(firstLayer)
    const rollback = join(firstLayer.rollbackDir, 'ROLLBACK.sh')
    writeFileSync(s.paths.instructions, 'prior recovery instructions\n')
    writeFileSync(rollback, '#!/bin/bash\n# prior rollback\n')
    const intent = interrupt(s, boundary)
    const before = tree(s.root)
    assert.equal(typeof validateRetainedRecovery(s.ctx, readLayers(s.root)), 'function')
    assert.deepEqual(tree(s.root), before, 'admission itself must be read-only')
    const journal = readLayers(s.root)
    assert.ok(journal.recovery)
    for (const pin of [...oldPins, executingLib()])
      assert.ok(journal.recovery.pinnedLibs.includes(pin), 'both controllers remain pinned')
    if (boundary === 'before-entry') {
      assert.deepEqual(readFileSync(s.paths.entry), oldEntry)
      assert.equal(journal.recovery.controlLib, s.lib)
    } else {
      assert.equal(readFileSync(s.paths.entry, 'utf8'), offScript(journal.layers, s.options))
      assert.equal(
        journal.recovery.controlLib,
        ['after-settlement', 'after-receipt'].includes(boundary) ? executingLib() : s.lib,
      )
    }
    if (['before-entry', 'after-entry'].includes(boundary)) {
      assert.equal(readFileSync(s.paths.instructions, 'utf8'), 'prior recovery instructions\n')
      assert.equal(readFileSync(rollback, 'utf8'), '#!/bin/bash\n# prior rollback\n')
    } else {
      assert.match(readFileSync(s.paths.instructions, 'utf8'), /Recover with system tools/)
      assert.doesNotMatch(readFileSync(rollback, 'utf8'), /prior rollback/)
    }
    // Full Off through the injected fake Mac, including prepare, files, cleanup
    // and terminal retirement. No production system tools are reachable here.
    s.system.running = false
    assert.equal(await runOff(s.ctx, offOptions), 0, s.out.join(''))
    assert.ok(!existsSync(publicationPath(s.root)), 'settled intent must leave the active slot')
    assert.ok(
      receipts(s).some((receipt) => receipt.equals(intent)),
      'exact intent bytes retained',
    )
    assert.deepEqual(readLayers(s.root).layers, [])
    assert.ok(s.phases.includes('off-files'))
    assert.ok(s.phases.includes('complete'))
  })

const tamper: Record<string, (s: Retained) => void> = {
  'unrelated entry': (s) => writeFileSync(s.paths.entry, '#!/bin/bash\nexit 0\n'),
  'missing intent': (s) => unlinkSync(publicationPath(s.root)),
  'malformed intent': (s) => writeFileSync(publicationPath(s.root), '{'),
  'unsafe intent mode': (s) => chmodSync(publicationPath(s.root), 0o666),
  'unsafe receipt directory': (s) => chmodSync(join(s.paths.directory, 'publications'), 0o777),
  'journal changed after intent': (s) => {
    const file = readLayers(s.root)
    assert.ok(file.recovery)
    file.recovery.pinnedLibs.push(join(s.root, 'lib/unrelated'))
    writeLayers(s.root, file)
  },
  'intent claims unrelated controller': (s) => {
    const path = publicationPath(s.root)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.controlLib = join(s.home, 'unrelated-controller')
    writeFileSync(path, JSON.stringify(value))
  },
  'intent claims unrelated bytes': (s) => {
    writeFileSync(s.paths.entry, '#!/bin/bash\n# tampered but hashed\nexit 0\n')
    const path = publicationPath(s.root)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.entryAfter = '0'.repeat(64)
    writeFileSync(path, JSON.stringify(value))
  },
  'recorded controller hash': (s) => {
    const path = publicationPath(s.root)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.controller.sha = '0'.repeat(64)
    writeFileSync(path, JSON.stringify(value))
  },
  'prior controller file mode': (s) => chmodSync(join(s.lib, 'install-manifest.json'), 0o600),
  'prior controller file bytes': (s) => {
    const path = join(s.lib, 'install-manifest.json')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
  },
  'recorded previous controller hash': (s) => {
    const path = publicationPath(s.root)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.previousController.sha = '0'.repeat(64)
    writeFileSync(path, JSON.stringify(value))
  },
  'recorded entry path': (s) => {
    const path = publicationPath(s.root)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.entryPath = join(s.home, 'unrelated-entry')
    writeFileSync(path, JSON.stringify(value))
  },
  'recorded entry mode': (s) => {
    const path = publicationPath(s.root)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.entryMode = 0o755
    writeFileSync(path, JSON.stringify(value))
  },
  'recorded generation options': (s) => {
    const path = publicationPath(s.root)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.generation.quitWaitSeconds = 31
    writeFileSync(path, JSON.stringify(value))
  },
  'unsupported intent field': (s) => {
    const path = publicationPath(s.root)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    value.relaxed = true
    writeFileSync(path, JSON.stringify(value))
  },
}
for (const [name, mutate] of Object.entries(tamper))
  test(`interrupted publication rejects ${name} before Off intent or mutations`, async () => {
    const s = await retained()
    interrupt(s, 'after-entry')
    mutate(s)
    const before = tree(s.root)
    s.system.running = false
    assert.equal(await runOff(s.ctx, offOptions), 1)
    assert.deepEqual(s.phases, [])
    assert.deepEqual(tree(s.root), before)
  })

test('matching pending hash cannot authorize bytes unrelated to the named immutable generator', async () => {
  const s = await retained()
  interrupt(s, 'after-entry')
  const { digest } = await import('../src/control-layer-state.mjs')
  const changed = Buffer.from('#!/bin/bash\n# a self-consistent forged hash\nexit 0\n')
  writeFileSync(s.paths.entry, changed)
  const path = publicationPath(s.root)
  const value = JSON.parse(readFileSync(path, 'utf8'))
  value.entryAfter = digest(changed)
  writeFileSync(path, JSON.stringify(value))
  const before = tree(s.root)
  assert.throws(() => prepareRecovery(s.ctx), /entry changed/)
  assert.deepEqual(tree(s.root), before)
})

test('a pending publication blocks a new On publisher until retained recovery settles it', async () => {
  const s = await retained()
  const intent = interrupt(s, 'after-entry')
  const before = tree(s.root)
  assert.throws(() => publishRecovery(s.options), /unfinished recovery publication/)
  assert.deepEqual(tree(s.root), before)
  assert.throws(
    () => prepareRecovery(s.ctx, join(s.root, 'lib/next')),
    /unfinished recovery publication/,
  )
  assert.deepEqual(
    tree(s.root),
    before,
    'pre-quit On must not invalidate the pending journal binding',
  )
  prepareRecovery(s.ctx)
  assert.equal(readLayers(s.root).recovery?.controlLib, executingLib())
  assert.ok(receipts(s).some((receipt) => receipt.equals(intent)))
  const settled = tree(s.root)
  prepareRecovery(s.ctx)
  assert.deepEqual(tree(s.root), settled, 'settled admission remains read-only')
})

test('publication intent changes after admission refuse settlement without overwriting evidence', async () => {
  const s = await retained()
  interrupt(s, 'after-entry')
  const settle = validateRetainedRecovery(s.ctx, readLayers(s.root))
  assert.ok(settle)
  const path = publicationPath(s.root)
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
  const before = tree(s.root)
  assert.throws(() => settle(() => {}), /publication changed/)
  assert.deepEqual(tree(s.root), before)
})

// recoveryEvidence retains the unchanged pre-sidecar Bash/JXA journal reader.
// Exercise that real system JXA reader against the interrupted old journal,
// including physical backup admission, without invoking app/job mutations.
test('older strict Bash/JXA journal reader still admits the pending-publication journal', {
  skip: process.platform !== 'darwin',
}, async () => {
  const s = await retained()
  interrupt(s, 'before-entry')
  const source =
    recoveryEvidence +
    '\nfunction run(args) { var f = journal(args[0]); return f.recovery.controlLib }\n'
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-', s.root], {
    input: source,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: s.home },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), s.lib)
  assert.deepEqual(Object.keys(readLayers(s.root).recovery ?? {}).sort(), [
    'controlLib',
    'entry',
    'pinnedLibs',
  ])
})

// A prior manifested generator with a real Bash body, rather than the inert
// legacy-generator fixture used for Node admission tests above.
function recordedBash(s: Retained): void {
  const script = offScript(readLayers(s.root).layers, s.options).replace(
    '# AnyEngine recovery:',
    '# Retained prior controller recovery:',
  )
  const name = 'dist/src/recovery-template.mjs'
  const generator = `export function offScript() { return ${JSON.stringify(script)} }\n`
  writeFileSync(join(s.lib, name), generator)
  const manifest = join(s.lib, 'install-manifest.json')
  const value = JSON.parse(readFileSync(manifest, 'utf8'))
  value.files[name] = digest(Buffer.from(generator))
  writeFileSync(manifest, JSON.stringify(value))
  writeFileSync(s.paths.entry, script)
  // retained() uses an intentionally invalid flip marker for read-only refusal
  // tests. This scenario exercises the supported foreground controller instead.
  unlinkSync(join(s.root, 'state/flip.json'))
}
function bashFullOff(s: Retained) {
  const installed = readFileSync(s.paths.entry, 'utf8')
  let runner = installed
  const tools: Record<string, [string, string]> = {
    LAUNCHCTL: [
      '/bin/launchctl',
      `case "$1:$2" in
        print:gui/*/*)
          printf 'Bad request.\\nCould not find service "%s" in domain for user gui: %s\\n' "\${2##*/}" "$(/usr/bin/id -u)" >&2
          exit 113;;
        print:gui/*) exit 0;;
        *) exit 91;;
      esac`,
    ],
    PLUTIL: ['/usr/bin/plutil', 'echo ChatGPT'],
    PGREP: ['/usr/bin/pgrep', 'exit 1'],
    OSASCRIPT: ['/usr/bin/osascript', 'exit 92'],
    OPEN: ['/usr/bin/open', 'exit 93'],
    CURL: ['/usr/bin/curl', 'exit 94'],
  }
  for (const [name, [command, body]] of Object.entries(tools)) {
    const path = join(s.home, `terminal-${name.toLowerCase()}.sh`)
    writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o700 })
    const binding = `${name}=${shellQuote(command)}`
    assert.equal(installed.split(binding).length, 2, `one immutable ${name} binding`)
    runner = runner.replace(binding, `${name}=${shellQuote(path)}`)
  }
  // Execute the installed Bash/JXA implementation verbatim except for its six
  // immutable Mac-tool bindings. No real app, launchd job or network is reachable.
  const path = join(s.home, 'terminal-bash-off.sh')
  writeFileSync(path, runner, { mode: 0o700 })
  const result = spawnSync('/bin/bash', [path, '--no-restart'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { HOME: s.home, PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.ok(!existsSync(s.paths.journal), 'actual Bash must retire the live journal')
  assert.ok(existsSync(publicationPath(s.root)), 'Bash leaves the Node publication intent')
  s.system.running = false
  s.system.jobs.clear() // The fake Mac now reflects the Bash fixture's absent jobs.
  return result
}
async function terminalFixture(boundary: Boundary = 'after-entry') {
  const s = await retained()
  recordedBash(s)
  const intent = interrupt(s, boundary)
  const snapshot = publicationJournalPath(s.root, JSON.parse(intent.toString()).id)
  assert.equal(digest(readFileSync(snapshot)), JSON.parse(intent.toString()).journalBefore)
  bashFullOff(s)
  return { ...s, intent, snapshot }
}

for (const boundary of [
  'before-entry',
  'after-entry',
  'before-settlement',
  'after-settlement',
  'after-receipt',
] as const)
  test(`publication ${boundary} -> actual Bash full Off -> supported Node On`, {
    skip: process.platform !== 'darwin',
  }, async () => {
    const s = await terminalFixture(boundary)
    const before = tree(s.root)
    assert.equal(typeof validateRetainedRecovery(s.ctx, readLayers(s.root)), 'function')
    assert.deepEqual(tree(s.root), before, 'terminal admission must remain read-only')
    const verify = s.deps.verifyLib
    // The selected next library is the same explicitly synthetic On fixture
    // used by flip-controller tests. Prior recovery still uses the real verifier.
    s.deps.verifyLib = (lib) => (lib === s.plan.libDir ? [] : verify(lib))
    const gate = s.deps.mandatoryGate
    assert.ok(gate)
    let gateCalls = 0
    s.deps.mandatoryGate = (request, observe) => {
      gateCalls += 1
      return gate(request, observe)
    }
    // Normal On must reopen the fake Mac and complete mandatory postflight.
    // --no-restart intentionally returns 1 while postflight remains pending.
    assert.equal(
      await s.run('on', ['--yes', '--auto-rollback', '--lib', s.plan.version]),
      0,
      s.out.join(''),
    )
    assert.equal(gateCalls, 1, 'normal On must cross the mandatory installed deployment gate')
    assert.equal(s.system.running, true, 'normal On reopens the configured fake app')
    assert.ok(!existsSync(join(s.root, 'state/flip.json')), 'terminal postflight clears its marker')
    assert.ok(!existsSync(publicationPath(s.root)), 'Node owner retires only the active intent')
    assert.ok(receipts(s).some((receipt) => receipt.equals(s.intent)))
    assert.ok(existsSync(s.snapshot), 'bound journal and prior authorities remain retained')
    assert.ok(readLayers(s.root).layers.some((layer) => layer.name === 'router'))
    assert.ok(
      s.out.some((line) => line.includes('scratch')),
      'supported On crosses its scratch proof',
    )
  })

test('actual Bash terminal recovery also permits a subsequent Node Off retry', {
  skip: process.platform !== 'darwin',
}, async () => {
  const s = await terminalFixture()
  assert.equal(await runOff(s.ctx, offOptions), 0, s.out.join(''))
  assert.ok(!existsSync(publicationPath(s.root)))
  assert.ok(!existsSync(s.paths.journal), 'terminal admission must not resurrect the old journal')
  assert.ok(receipts(s).some((receipt) => receipt.equals(s.intent)))
})

test('missing live journal without completed Bash layers cannot retire publication', async () => {
  const s = await retained()
  interrupt(s, 'after-entry')
  unlinkSync(s.paths.journal)
  const before = tree(s.root)
  assert.throws(() => settleTerminalRecovery(s.ctx))
  assert.deepEqual(tree(s.root), before)
})

const terminalTamper: Record<string, (s: Awaited<ReturnType<typeof terminalFixture>>) => void> = {
  'missing bound journal': (s) => unlinkSync(s.snapshot),
  'changed bound journal': (s) => writeFileSync(s.snapshot, '{}\n'),
  'unsafe bound journal': (s) => chmodSync(s.snapshot, 0o666),
  'missing layer completion marker': (s) => {
    const file = JSON.parse(readFileSync(s.snapshot, 'utf8')) as LayerFile
    const layer = file.layers[0]
    assert.ok(layer)
    unlinkSync(join(layer.rollbackDir, POPPED))
  },
  'changed layer completion marker': (s) => {
    const file = JSON.parse(readFileSync(s.snapshot, 'utf8')) as LayerFile
    const layer = file.layers[0]
    assert.ok(layer)
    writeFileSync(join(layer.rollbackDir, POPPED), 'forged')
  },
  'changed backup': (s) => {
    const file = JSON.parse(readFileSync(s.snapshot, 'utf8')) as LayerFile
    const layer = file.layers.find((row) => row.changes.some((c) => c.backup))
    const change = layer?.changes.find((c) => c.backup)
    assert.ok(layer && change?.backup)
    writeFileSync(join(layer.rollbackDir, change.backup), 'changed')
  },
  'unrelated public recovery': (s) => {
    mkdirSync(dirname(join(s.root, 'bin/anyengine-off')), { recursive: true })
    writeFileSync(join(s.root, 'bin/anyengine-off'), '#!/bin/bash\nexit 0\n')
  },
  'unretired milestone': (s) => writeFileSync(join(s.root, 'm2-upgrade.json'), '{}\n'),
  'changed entry': (s) => writeFileSync(s.paths.entry, '#!/bin/bash\nexit 0\n'),
  'changed intent': (s) => writeFileSync(publicationPath(s.root), '{}\n'),
  'changed prior controller': (s) => {
    const path = join(s.lib, 'install-manifest.json')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n`)
  },
}
for (const [name, mutate] of Object.entries(terminalTamper))
  test(`Bash-terminal publication rejects ${name} without discarding authority`, {
    skip: process.platform !== 'darwin',
  }, async () => {
    const s = await terminalFixture()
    mutate(s)
    const before = tree(s.root)
    assert.throws(() => settleTerminalRecovery(s.ctx))
    assert.deepEqual(tree(s.root), before)
  })
