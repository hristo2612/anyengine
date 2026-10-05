import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)
const sites = [
  'src/util.mts',
  'test/compat-version.test.mts',
  'test/doctor.test.mts',
  'scripts/codex-shim',
  '.github/workflows/ci.yml',
  'docs/guide/configuration.md',
  'docs/reference/capability-matrix.md',
  'docs/reference/release-readiness.md',
  'crates/anyengine-protocol/README.md',
]
for (const behavior of ['success', 'failed', 'timeout'])
  test(`default compatibility version probe isolates homes and actual outcome: ${behavior}`, async () => {
    assert.ok(process.env.HERMETIC_TEST_ROOT)
    const work = await tempDir('compat-isolated-')
    const repo = join(work, 'repo'),
      home = join(work, 'caller-home'),
      codexHome = join(home, '.codex')
    const marker = join(work, 'outside-write'),
      pidFile = join(work, 'raw-pid')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'auth.json'), '{"fixture":"fake-only"}')
    for (const site of sites) {
      mkdirSync(dirname(join(repo, site)), { recursive: true })
      cpSync(resolve(site), join(repo, site))
    }
    const before = readFileSync(join(repo, 'src/util.mts'))
    const binary = join(work, 'fake-version.mjs')
    writeFileSync(
      binary,
      `#!${process.execPath}
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
try { writeFileSync(${JSON.stringify(marker)},'outside mutation');writeFileSync(${JSON.stringify(pidFile)},String(process.pid)) } catch {}
const leaked=process.env.HOME===${JSON.stringify(home)}||process.env.CODEX_HOME===${JSON.stringify(codexHome)}||process.env.OPENAI_API_KEY!==undefined||existsSync(join(process.env.CODEX_HOME,'auth.json'))
console.log('codex-cli 9.8.7-alpha.1')
if(${JSON.stringify(behavior)}==='timeout')setInterval(()=>{},1000)
else process.exit(leaked||${JSON.stringify(behavior)}==='failed'?3:0)
`,
      { mode: 0o755 },
    )
    try {
      const started = performance.now()
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/sync-codex-compat.mjs'), '--root', repo],
        {
          env: {
            ...process.env,
            HOME: home,
            CODEX_HOME: codexHome,
            ANYENGINE_REAL_CODEX: binary,
            ANYENGINE_CHATGPT_APP: join(work, 'absent.app'),
            OPENAI_API_KEY: 'fixture-key',
          },
          encoding: 'utf8',
          timeout: 35_000,
        },
      )
      assert.equal(result.signal, null, 'shared probe must settle inside its own deadline')
      assert.equal(result.status, behavior === 'success' ? 0 : 1, result.stderr)
      assert.ok(performance.now() - started < 35_000)
      assert.equal(existsSync(marker), false)
      if (behavior !== 'success') assert.deepEqual(readFileSync(join(repo, 'src/util.mts')), before)
      assert.equal(readFileSync(join(codexHome, 'auth.json'), 'utf8'), '{"fixture":"fake-only"}')
    } finally {
      await settleRawFixture(pidFile)
    }
  })
async function settleRawFixture(pidFile: string) {
  // Old raw-probe RED may outlive a terminated CLI; this exact fake PID is owned.
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8'))
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
      throw error
    }
    await new Promise((done) => setTimeout(done, 20))
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
}
