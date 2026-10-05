import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { runDoctor } from '../src/control-doctor.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

for (const missing of [
  'declaration',
  'scripts/lib/codex-probe-runner.mjs',
  'test/fixtures/claude-permission-modes.json',
  'test/fixtures/posture-schema.json',
  'crates/anyengine-protocol/fixtures/initialize.request.json',
  'symlink',
  'unreadable',
]) {
  test(`doctor refuses unsupported installed capability ${missing} before executing it`, async () => {
    const home = await tempDir('doctor-capability-')
    const root = join(home, '.anyengine')
    const codex = join(home, '.codex')
    const lib = join(root, 'lib/v1')
    mkdirSync(codex)
    for (const entry of [
      'scripts',
      'dist/src',
      'test/fixtures/claude-permission-modes.json',
      'test/fixtures/posture-schema.json',
      'crates/anyengine-protocol/fixtures',
    ]) {
      mkdirSync(join(lib, entry, '..'), { recursive: true })
      cpSync(resolve(entry), join(lib, entry), { recursive: true })
    }
    symlinkSync('v1', join(root, 'lib/current'))
    const marker = join(codex, 'legacy-ran')
    writeFileSync(
      join(lib, 'scripts/doctor.mjs'),
      `#!/usr/bin/env node\n// anyengine-doctor-isolation: ${missing === 'declaration' ? 99 : 1}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');console.log('{}');`,
    )
    const helper = join(lib, 'scripts/lib/codex-probe.mjs')
    if (missing === 'symlink') {
      rmSync(helper)
      symlinkSync(resolve('scripts/lib/codex-probe.mjs'), helper)
    } else if (missing === 'unreadable') chmodSync(helper, 0)
    else if (missing !== 'declaration') rmSync(join(lib, missing))
    const system = fakeSystem(home)
    const fixtureExec = system.exec.bind(system)
    let executed = false
    system.exec = (command, args, options) => {
      if (args[0] !== join(lib, 'scripts/doctor.mjs')) return fixtureExec(command, args, options)
      executed = true
      const result = spawnSync(command, args, {
        env: options?.env,
        encoding: 'utf8',
        timeout: 5000,
      })
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    }
    try {
      const report = await runDoctor(system, root, { codexHome: codex })
      assert.equal(report.length, 20)
      assert.equal(report[0]?.level, 'fail')
      assert.equal(executed, false, 'unsupported installed code must not start')
      assert.equal(existsSync(marker), false, 'observed home remains untouched')
      assert.match(report[0]?.detail ?? '', /unsupported installed doctor/)
    } finally {
      if (missing === 'unreadable') chmodSync(helper, 0o644)
    }
  })
}

test('control doctor refuses a legacy installed helper before it can probe the observed home', async (t) => {
  const home = await tempDir('review-legacy-doctor-')
  const root = join(home, '.anyengine')
  const codex = join(home, '.codex')
  const lib = join(root, 'lib/legacy')
  mkdirSync(join(lib, 'scripts'), { recursive: true })
  mkdirSync(codex)
  symlinkSync('legacy', join(root, 'lib/current'))
  const fake = join(home, 'fake-codex.mjs')
  writeFileSync(
    fake,
    `import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
    const out=join(process.env.CODEX_HOME,'tmp','arg0'); mkdirSync(out,{recursive:true});
    writeFileSync(join(out,'legacy-version-observation.json'),JSON.stringify({home:process.env.HOME,codex:process.env.CODEX_HOME,args:process.argv.slice(2)}));
    console.log('codex-cli 0.159.0');`,
  )
  writeFileSync(
    join(lib, 'scripts/doctor.mjs'),
    `import {spawnSync} from 'node:child_process';
    const result=spawnSync(process.execPath,[${JSON.stringify(fake)},'--version'],{env:process.env,encoding:'utf8'});
    console.log('ok - legacy bundled codex: '+result.stdout.trim());`,
  )
  writeFileSync(join(lib, 'scripts/preflip-check.mjs'), '// disposable, never executed')
  const system = fakeSystem(home)
  const fixtureExec = system.exec.bind(system)
  system.exec = (command, args, options) => {
    if (args[0] !== join(lib, 'scripts/doctor.mjs')) return fixtureExec(command, args, options)
    const result = spawnSync(command, args, { env: options?.env, encoding: 'utf8', timeout: 5000 })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
  const report = await runDoctor(system, root, { codexHome: codex })
  const first = report[0]
  assert.ok(first)
  const observation = join(codex, 'tmp/arg0/legacy-version-observation.json')
  const seen = existsSync(observation) ? JSON.parse(readFileSync(observation, 'utf8')) : null
  t.diagnostic(
    JSON.stringify({
      check: first,
      seen,
      syntheticHome: home,
      syntheticCodex: codex,
      totalChecks: report.length,
    }),
  )
  assert.equal(first.level, 'fail')
  assert.equal(report.length, 20)
  assert.equal(
    existsSync(observation),
    false,
    'unsupported installed helper must not invoke a version probe in observed homes before refusal',
  )
})
