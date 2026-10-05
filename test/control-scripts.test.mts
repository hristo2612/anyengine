import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { enginePaths } from '../src/anyengine-config.mjs'
import {
  LayerWriter,
  POPPED,
  readLayers,
  recoveryPaths,
  restoreChange,
  writeLayers,
} from '../src/control-layers.mjs'
import { offScript, publishRecovery, rollbackScript, shellQuote } from '../src/control-scripts.mjs'
import { removeTempDirs } from './helpers/tmp.mjs'

after(removeTempDirs)

import { configure, required, run, setup } from './helpers/recovery-home.mjs'

function ok(result: ReturnType<typeof run>) {
  assert.equal(result.status, 0, result.stdout + result.stderr)
}

test('invalid selectors refuse before crossing an active M3 recovery boundary', async () => {
  const s = await setup()
  const moved = join(s.home, 'm3-ran')
  const recover = join(s.root, 'recovery/m3/recover.sh')
  mkdirSync(dirname(recover), { recursive: true })
  writeFileSync(recover, `#!/bin/bash\n/usr/bin/touch ${shellQuote(moved)}\nexit 1\n`)
  writeFileSync(join(s.root, 'm3-upgrade.json'), JSON.stringify({ phase: 'active' }))
  for (const args of [
    ['--unknown'],
    ['--m2-only', '--router-only'],
    ['--m2-only', '--last-good'],
  ]) {
    assert.equal(run(s, ...args).status, 2)
    assert.equal(existsSync(moved), false)
  }
})

test('recovery executes actual Bash 3.2 with system PATH, restores quoted files/links and clears terminal journal', async () => {
  const s = await setup(true)
  const target = join(s.home, "it's here ü.txt")
  writeFileSync(target, 'before\n')
  s.writer.writeFile(target, 'after\n', 0o640)
  s.writer.writeSymlink(join(s.home, 'link'), "lib ' new")
  ok(run(s, '--no-restart'))
  assert.equal(readFileSync(target, 'utf8'), 'before\n')
  assert.ok(!existsSync(join(s.home, 'link')))
  assert.ok(!existsSync(enginePaths(s.root).layers))
  assert.ok(existsSync(recoveryPaths(s.root).entry))
  assert.ok(!existsSync(join(s.root, 'bin', 'anyengine-off')))
})

test('outer and direct entries refuse running or unknown app before dependent changes', async () => {
  for (const direct of [false, true])
    for (const query of ['echo 123; exit 0', 'exit 2', 'echo problem >&2; exit 1']) {
      const s = await setup()
      s.writer.addJob('dev.anyengine.router')
      s.env.ANYENGINE_PGREP = s.stub('running', query)
      configure(s)
      const file = direct
        ? join(s.writer.layer.rollbackDir, 'ROLLBACK.sh')
        : recoveryPaths(s.root).entry
      const result = spawnSync('/bin/bash', [file, direct ? '--after-quit' : '--no-restart'], {
        env: s.env,
        encoding: 'utf8',
      })
      assert.notEqual(result.status, 0, result.stdout + result.stderr)
      assert.ok(!existsSync(s.calls))
      assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
      assert.ok(existsSync(recoveryPaths(s.root).entry))
    }
})

test('real bootout failure retains evidence and successful quit still reopens', async () => {
  const s = await setup()
  s.writer.addJob('dev.anyengine.router')
  s.env.ANYENGINE_LAUNCHCTL = s.stub(
    'bad-launchctl',
    `[ "$1" = print ] && exit 0; echo bootout >> ${shellQuote(s.calls)}; exit 9`,
  )
  configure(s)
  const result = run(s)
  assert.notEqual(result.status, 0)
  assert.match(readFileSync(s.calls, 'utf8'), /bootout\nopen/)
  assert.ok(existsSync(enginePaths(s.root).layers))
  assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
  s.env.ANYENGINE_LAUNCHCTL = s.stub(
    'absent-launchctl',
    `case "$2" in */dev.anyengine.router)
      printf 'Bad request.\\nCould not find service "dev.anyengine.router" in domain for user gui: %s\\n' "$(/usr/bin/id -u)" >&2
      exit 113;; esac; exit 0`,
  )
  configure(s)
  ok(run(s, '--no-restart'))
})

test('corrupt live journal bytes cannot authorize restoration or erase pins', async () => {
  const s = await setup()
  const target = join(s.home, 'target')
  s.writer.writeFile(target, 'new', 0o600)
  const path = enginePaths(s.root).layers
  const bytes = Buffer.from(readFileSync(path, 'utf8').replace('target', 'targXt'))
  bytes[bytes.indexOf('targXt') + 4] = 0xff
  writeFileSync(path, bytes)
  const result = run(s, '--no-restart')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr + result.stdout, /invalid|UTF|evidence/i)
  assert.deepEqual(readFileSync(path), bytes)
  assert.equal(readFileSync(target, 'utf8'), 'new')
})

test('Node-free recovery waits for launchd to finish an acknowledged bootout', async () => {
  const s = await setup()
  const stopped = join(s.home, 'bootout-acknowledged')
  const count = join(s.home, 'absence-queries')
  s.writer.addJob('dev.anyengine.router')
  s.env.ANYENGINE_LAUNCHCTL = s.stub(
    'async-launchctl',
    `case "$1" in
      bootout) /usr/bin/touch ${shellQuote(stopped)}; exit 0;;
      print)
        [ "$2" != "gui/$(/usr/bin/id -u)" ] || { echo domain; exit 0; }
        [ -f ${shellQuote(stopped)} ] || { echo loaded; exit 0; }
        n=0; [ ! -f ${shellQuote(count)} ] || n=$(/bin/cat ${shellQuote(count)})
        n=$((n+1)); echo "$n" > ${shellQuote(count)}
        [ "$n" -ge 3 ] || { echo loaded; exit 0; }
        printf 'Bad request.\\nCould not find service "dev.anyengine.router" in domain for user gui: %s\\n' "$(/usr/bin/id -u)" >&2
        exit 113;;
    esac`,
  )
  configure(s)
  ok(run(s, '--no-restart'))
  assert.equal(Number(readFileSync(count, 'utf8')), 3)
})

test('published pending and settled files both restore and match Node', async () => {
  for (const landed of [false, true]) {
    const s = await setup()
    const target = join(s.home, 'target')
    writeFileSync(target, 'original\n')
    s.writer.writeFile(target, 'old\n', 0o600)
    const fail = new LayerWriter(
      s.root,
      required(readLayers(s.root).layers[0]),
      'router',
      'test',
      () => {
        throw new Error('interrupted before scripts')
      },
    )
    assert.throws(() => fail.writeFile(target, 'new\n', 0o600), /interrupted/)
    if (landed) writeFileSync(target, 'new\n', { mode: 0o600 })
    const layer = required(readLayers(s.root).layers[0])
    const nodeCopy = join(s.home, 'node-copy')
    copyFileSync(target, nodeCopy)
    // copyFile preserves mode on this platform.
    const result = restoreChange(
      { ...required(layer.changes[0]), target: nodeCopy },
      layer.rollbackDir,
      true,
    )
    assert.equal(result.outcome, 'restored')
    ok(run(s, '--no-restart'))
    assert.deepEqual(readFileSync(target), readFileSync(nodeCopy))
  }
})

test('last-good upgrade restores prior M1 and retains initial ladder and journal', async () => {
  const s = await setup()
  const target = join(s.home, 'target')
  writeFileSync(target, 'vanilla')
  s.writer.writeFile(target, 'M1 old', 0o600)
  s.writer.beginUpgrade()
  s.writer.writeFile(target, 'M1 new', 0o600)
  ok(run(s, '--last-good', '--no-restart'))
  assert.equal(readFileSync(target, 'utf8'), 'M1 old')
  assert.ok(existsSync(recoveryPaths(s.root).entry))
  assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
  ok(run(s, '--no-restart'))
  assert.equal(readFileSync(target, 'utf8'), 'vanilla')
})

for (const interruption of ['intent', 'settled', 'none'] as const) {
  test(`absent intent ${interruption} remains recoverable to last-good then initial with actual Bash`, async () => {
    const s = await setup()
    const target = join(s.home, 'smoke.plist')
    writeFileSync(target, 'original')
    s.writer.writeFile(target, 'enabled', 0o600)
    s.writer.beginUpgrade()
    const writer = new LayerWriter(
      s.root,
      required(readLayers(s.root).layers[0]),
      'router',
      'remove',
      (_, phase) => {
        if (phase === 'intent') {
          assert.equal(readFileSync(target, 'utf8'), 'enabled')
          assert.equal(readLayers(s.root).layers[0]?.changes[0]?.pending?.kind, 'absent')
        }
        publishRecovery(s.options)
        if (phase === interruption) throw new Error(`interrupted ${phase}`)
      },
    )
    if (interruption === 'none') {
      assert.equal(writer.removeFile(target), true)
      assert.equal(writer.removeFile(target), false)
    } else {
      assert.throws(() => writer.removeFile(target), /interrupted/)
      assert.throws(() => writer.removeFile(target), /incomplete/)
    }
    assert.equal(existsSync(target), interruption === 'intent')
    const change = required(readLayers(s.root).layers[0]?.changes[0])
    assert.ok(change.beforeSha)
    assert.ok(change.lastGood?.sha)
    assert.equal(change.pending?.kind ?? null, interruption === 'intent' ? 'absent' : null)
    assert.ok(existsSync(recoveryPaths(s.root).entry))
    ok(run(s, '--last-good', '--no-restart'))
    assert.equal(readFileSync(target, 'utf8'), 'enabled')
    ok(run(s, '--no-restart'))
    assert.equal(readFileSync(target, 'utf8'), 'original')
  })
}

async function smokeRecovery(priorEnabled: boolean, failure = '') {
  const s = await setup()
  const label = 'dev.anyengine.smoke'
  const plist = join(s.home, 'Library/LaunchAgents', `${label}.plist`)
  const loaded = join(s.home, 'smoke-loaded')
  const fault = join(s.home, 'job-fault')
  const jobCalls = join(s.home, 'job-calls')
  mkdirSync(dirname(plist), { recursive: true })
  s.env.ANYENGINE_LAUNCHCTL = s.stub(
    'stateful-launchctl',
    `
printf '%s\\n' "$*" >> ${shellQuote(jobCalls)}
case "$1" in
  print)
    case "$2" in */${label})
      if [ -f ${shellQuote(fault)} ] && [ "$(/bin/cat ${shellQuote(fault)})" = unknown ]; then echo unknown >&2; exit 2; fi
      [ ! -f ${shellQuote(loaded)} ] || exit 0
      printf 'Bad request.\\nCould not find service "${label}" in domain for user gui: %s\\n' "$(/usr/bin/id -u)" >&2; exit 113;;
    esac
    if [ -f ${shellQuote(fault)} ] && [ "$(/bin/cat ${shellQuote(fault)})" = stop-domain ]; then echo unreadable-domain >&2; exit 2; fi;;
  kickstart) [ -f ${shellQuote(loaded)} ] || exit 9;;
  bootstrap)
    if [ -f ${shellQuote(fault)} ]; then
      case "$(/bin/cat ${shellQuote(fault)})" in
        stderr) echo bootstrap-failed >&2; exit 0;;
        status) exit 9;;
      esac
    fi
    [ "$3" = ${shellQuote(plist)} ] && [ -f "$3" ] || exit 8
    /usr/bin/touch ${shellQuote(loaded)};;
  bootout)
    if [ -f ${shellQuote(fault)} ]; then
      case "$(/bin/cat ${shellQuote(fault)})" in
        stop-stderr) echo bootout-failed >&2; exit 0;;
        stop-loaded) exit 0;;
        stop-unknown) /bin/rm -f ${shellQuote(loaded)}; echo unknown > ${shellQuote(fault)}; exit 0;;
        stop-domain) /bin/rm -f ${shellQuote(loaded)}; exit 0;;
        stop-race) /bin/rm -f ${shellQuote(loaded)}; echo already-gone >&2; exit 9;;
      esac
    fi
    /bin/rm -f ${shellQuote(loaded)};;
esac
exit 0`,
  )
  configure(s)
  s.writer.writeFile(plist, 'enabled', 0o600)
  s.writer.addJob(label)
  writeFileSync(loaded, '')
  s.writer.beginUpgrade()
  s.writer.removeFile(plist)
  rmSync(loaded)
  if (!priorEnabled) {
    s.writer.finishUpgrade()
    s.writer.beginUpgrade()
    s.writer.writeFile(plist, 'enabled', 0o600)
    writeFileSync(loaded, '')
  }
  if (failure) writeFileSync(fault, failure)
  return { ...s, plist, loaded, fault, jobCalls }
}

for (const lastGood of [true, false])
  for (const fault of ['stop-stderr', 'stop-loaded']) {
    test(`Node-free ${lastGood ? 'prior-disabled last-good' : 'ordinary Off'} refuses ${fault}, retains authority and retries`, async () => {
      const s = await smokeRecovery(false, fault)
      const args = lastGood ? ['--last-good', '--no-restart'] : ['--no-restart']
      const journal = readFileSync(recoveryPaths(s.root).journal)
      const result = run(s, ...args)
      assert.notEqual(result.status, 0, result.stdout + result.stderr)
      assert.equal(existsSync(s.plist), false)
      assert.equal(existsSync(s.loaded), true)
      assert.deepEqual(readFileSync(recoveryPaths(s.root).journal), journal)
      assert.ok(readLayers(s.root).layers[0]?.upgrade)
      assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
      assert.ok(existsSync(recoveryPaths(s.root).entry))
      if (fault === 'stop-stderr') assert.match(result.stderr, /bootout-failed/)
      else assert.match(result.stderr, /absence not proven/)
      rmSync(s.fault)
      ok(run(s, ...args))
      assert.equal(existsSync(s.loaded), false)
      assert.equal(existsSync(s.plist), false)
      const calls = readFileSync(s.jobCalls, 'utf8')
      ok(run(s, ...args))
      assert.equal(
        readFileSync(s.jobCalls, 'utf8').split('bootout').length,
        calls.split('bootout').length,
      )
    })
  }

for (const fault of ['unknown', 'stop-unknown', 'stop-domain']) {
  test(`Node-free prior-disabled last-good refuses ${fault} query and retries confirmed absence`, async () => {
    const s = await smokeRecovery(false, fault)
    const journal = readFileSync(recoveryPaths(s.root).journal)
    const result = run(s, '--last-good', '--no-restart')
    assert.notEqual(result.status, 0)
    assert.deepEqual(readFileSync(recoveryPaths(s.root).journal), journal)
    assert.ok(readLayers(s.root).layers[0]?.upgrade)
    assert.equal(existsSync(s.loaded), fault === 'unknown')
    if (fault === 'unknown') assert.doesNotMatch(readFileSync(s.jobCalls, 'utf8'), /bootout/)
    else assert.match(result.stderr, /absence not proven/)
    rmSync(s.fault)
    ok(run(s, '--last-good', '--no-restart'))
    assert.equal(existsSync(s.loaded), false)
    assert.equal(existsSync(s.plist), false)
  })
}

test('Node-free prior-disabled last-good accepts a bootout race only with exact absence and readable domain', async () => {
  const s = await smokeRecovery(false, 'stop-race')
  const result = run(s, '--last-good', '--no-restart')
  ok(result)
  assert.match(result.stderr, /already-gone/)
  assert.equal(existsSync(s.loaded), false)
  assert.equal(existsSync(s.plist), false)
  assert.ok(readLayers(s.root).layers[0]?.upgrade)
  const calls = readFileSync(s.jobCalls, 'utf8').trim().split('\n')
  assert.match(required(calls.at(-2)), /^print gui\/\d+\/dev\.anyengine\.smoke$/)
  assert.match(required(calls.at(-1)), /^print gui\/\d+$/)
})

for (const priorEnabled of [true, false]) {
  test(`Node-free smoke last-good restores prior ${priorEnabled ? 'enabled' : 'disabled'} job state`, async () => {
    const s = await smokeRecovery(priorEnabled)
    ok(run(s, '--last-good', '--no-restart'))
    assert.equal(existsSync(s.plist), priorEnabled)
    assert.equal(existsSync(s.loaded), priorEnabled)
    ok(run(s, '--no-restart'))
    assert.equal(existsSync(s.plist), false)
    assert.equal(existsSync(s.loaded), false)
  })
}

for (const fault of ['unknown', 'status', 'stderr']) {
  test(`Node-free smoke last-good ${fault} failure retains authority and retries restored plist`, async () => {
    const s = await smokeRecovery(true, fault)
    const result = run(s, '--last-good', '--no-restart')
    assert.notEqual(result.status, 0)
    assert.equal(readFileSync(s.plist, 'utf8'), 'enabled')
    assert.equal(existsSync(s.loaded), false)
    assert.ok(readLayers(s.root).layers[0]?.upgrade)
    assert.ok(existsSync(recoveryPaths(s.root).entry))
    rmSync(s.fault)
    ok(run(s, '--last-good', '--no-restart'))
    assert.equal(existsSync(s.loaded), true)
  })
}

for (const invalid of ['unrecorded', 'ambiguous']) {
  test(`Node-free smoke last-good refuses ${invalid} prior plist authority`, async () => {
    const s = await smokeRecovery(true)
    if (invalid === 'unrecorded') {
      const file = readLayers(s.root)
      required(file.layers[0]).changes = []
      writeLayers(s.root, file)
    } else
      s.writer.writeFile(
        join(s.home, 'other/Library/LaunchAgents/dev.anyengine.smoke.plist'),
        'foreign',
        0o600,
      )
    const before = readFileSync(recoveryPaths(s.root).journal)
    assert.notEqual(run(s, '--last-good', '--no-restart').status, 0)
    assert.deepEqual(readFileSync(recoveryPaths(s.root).journal), before)
    assert.equal(existsSync(s.loaded), false)
    assert.ok(existsSync(recoveryPaths(s.root).entry))
  })
}

test('generated scripts parse under system Bash and use a quoted durable RECOVER command', async () => {
  const s = await setup(true)
  s.writer.writeFile(join(s.home, 'target'), 'new', 0o600)
  for (const script of [
    offScript([s.writer.layer], s.options),
    rollbackScript(s.writer.layer, s.options),
  ]) {
    const result = spawnSync('/bin/bash', ['-n'], { input: script, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  assert.match(spawnSync('/bin/bash', ['--version'], { encoding: 'utf8' }).stdout, /version 3\.2/)
  assert.ok(
    readFileSync(recoveryPaths(s.root).instructions, 'utf8').includes(
      shellQuote(recoveryPaths(s.root).entry),
    ),
  )
})

test('direct default rollback refuses a failed quit and successful direct copy-only needs no app tools', async () => {
  const s = await setup()
  const target = join(s.home, 'target')
  s.writer.writeFile(target, 'new', 0o600)
  s.writer.addJob('dev.anyengine.router')
  s.env.ANYENGINE_PGREP = s.stub('up', 'echo 123')
  configure(s)
  const script = join(s.writer.layer.rollbackDir, 'ROLLBACK.sh')
  const r = spawnSync('/bin/bash', [script], { env: s.env, encoding: 'utf8' })
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  assert.doesNotMatch(readFileSync(s.calls, 'utf8'), /bootout|open/)
  const staged = spawnSync('/bin/bash', [script, '--copy-only'], {
    env: { HOME: s.home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  })
  assert.equal(staged.status, 0, staged.stdout + staged.stderr)
  assert.ok(!existsSync(join(s.writer.layer.rollbackDir, POPPED)))
})

test('recovery reports both an after-quit failure and a failed reopen', async () => {
  const s = await setup()
  s.writer.addJob('dev.anyengine.router')
  s.env.ANYENGINE_LAUNCHCTL = s.stub('boot-fail', '[ "$1" = print ] && exit 0; exit 7')
  s.env.ANYENGINE_OPEN = s.stub('open-fail', 'exit 8')
  configure(s)
  const r = run(s)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /bootout.*failed/)
  assert.match(r.stderr, /reopen failed/)
  assert.ok(existsSync(enginePaths(s.root).layers))
})
