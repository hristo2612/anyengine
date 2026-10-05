import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { killChildren, spawn, waitForOutput } from './helpers/children.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(() => killChildren())
after(removeTempDirs)

const shim = resolve('scripts/codex-shim')
const sync = resolve('scripts/sync-codex-compat.mjs')
const PINNED = '0.160.0'
const SITES = [
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

function bundled(dir: string, version: string): string {
  const path = join(dir, 'codex')
  writeFileSync(path, `#!/bin/sh\necho "codex-cli ${version}"\n`)
  chmodSync(path, 0o755)
  return path
}

function shimVersion(env: NodeJS.ProcessEnv): string {
  const result = spawnSync(shim, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, ANYENGINE_RUNTIME_ENV: '/dev/null', ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('every written pin names the same codex version', () => {
  const result = spawnSync(process.execPath, [sync, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const lines = result.stdout.trim().split('\n')
  assert.deepEqual(
    lines.map((line) => line.split(' ')[0]),
    SITES,
  )
  for (const line of lines) assert.ok(line.endsWith(` ${PINNED}`), line)
})

test('sync moves every pin even when the bundled prerelease sorts below the old pin', async () => {
  const root = await tempDir('compat-alpha-')
  for (const site of SITES) {
    mkdirSync(dirname(join(root, site)), { recursive: true })
    cpSync(resolve(site), join(root, site))
  }
  for (const version of ['0.159.2', '0.159.0-alpha.12.1']) {
    const moved = spawnSync(process.execPath, [sync, '--root', root, '--version', version], {
      encoding: 'utf8',
    })
    assert.equal(moved.status, 0, moved.stderr)
    const check = spawnSync(process.execPath, [sync, '--check', '--root', root], {
      encoding: 'utf8',
    })
    assert.equal(check.status, 0, check.stdout)
    for (const line of check.stdout.trim().split('\n'))
      assert.ok(line.endsWith(` ${version}`), line)
  }
})

// No --version: sync asks the codex the shim and the adapter would run, found
// by their rule in whichever layout the app ships (26.928 moved it).
test('sync reads the version from the codex the layout rule finds', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-compat-app-'))
  try {
    for (const site of SITES) {
      mkdirSync(dirname(join(root, 'repo', site)), { recursive: true })
      cpSync(resolve(site), join(root, 'repo', site))
    }
    const app = join(root, 'ChatGPT.app')
    const codex = join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
    mkdirSync(dirname(codex), { recursive: true })
    writeFileSync(codex, '#!/bin/sh\necho "codex-cli 9.8.7-alpha.12.1"\n')
    chmodSync(codex, 0o755)
    const moved = spawnSync(process.execPath, [sync, '--root', join(root, 'repo')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANYENGINE_CHATGPT_APP: app,
        ANYENGINE_REAL_CODEX: join(app, 'Contents/Resources/codex'),
      },
    })
    assert.equal(moved.status, 0, moved.stderr)
    assert.ok(moved.stdout.includes(`bundled codex ${codex}: 9.8.7-alpha.12.1`), moved.stdout)
    assert.match(
      moved.stderr,
      /skipping ANYENGINE_REAL_CODEX=.*Contents\/Resources\/codex \(not executable\)/,
    )
    const check = spawnSync(process.execPath, [sync, '--check', '--root', join(root, 'repo')], {
      encoding: 'utf8',
    })
    for (const line of check.stdout.trim().split('\n'))
      assert.ok(line.endsWith(' 9.8.7-alpha.12.1'), line)
    const none = spawnSync(process.execPath, [sync, '--root', join(root, 'repo')], {
      encoding: 'utf8',
      env: { ...process.env, ANYENGINE_CHATGPT_APP: join(root, 'no-app') },
    })
    assert.equal(none.status, 1)
    assert.match(none.stderr, /no bundled codex in any ChatGPT\.app layout; pass --version/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the shim advertises the bundled codex version, then an explicit override, then the pin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyengine-compat-shim-'))
  try {
    const codex = bundled(dir, '9.8.7-alpha.12.1')
    assert.equal(
      shimVersion({ ANYENGINE_REAL_CODEX: codex }),
      'codex-cli 9.8.7-alpha.12.1 (anyengine)',
    )
    assert.equal(
      shimVersion({ ANYENGINE_REAL_CODEX: codex, ANYENGINE_COMPAT_VERSION: '1.2.3' }),
      'codex-cli 1.2.3 (anyengine)',
    )
    assert.equal(
      shimVersion({ ANYENGINE_REAL_CODEX: join(dir, 'gone') }),
      `codex-cli ${PINNED} (anyengine)`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the mock adapter launched by the shim uses the same pin without probing bundled Codex', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyengine-compat-ua-'))
  const codex = join(dir, 'codex')
  const probed = join(dir, 'probed')
  writeFileSync(
    codex,
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';try {writeFileSync(${JSON.stringify(probed)},'called')} catch {}\nconsole.log('codex-cli 9.8.7-alpha.12.1')\n`,
    { mode: 0o755 },
  )
  assert.equal(
    shimVersion({ ANYENGINE_MOCK: '1', ANYENGINE_REAL_CODEX: codex }),
    `codex-cli ${PINNED} (anyengine)`,
  )
  const proc = spawn(shim, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      CODEX_HOME: dir,
      ANYENGINE_RUNTIME_ENV: '/dev/null',
      ANYENGINE_MOCK: '1',
      ANYENGINE_NODE: process.execPath,
      ANYENGINE_ADAPTER: resolve('dist/src/adapter.mjs'),
      ANYENGINE_REAL_CODEX: codex,
    },
  })
  try {
    const initialize = { clientInfo: { name: 't', version: '0' } }
    proc.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initialize })}\n`,
    )
    await waitForOutput(proc, new RegExp(`"userAgent":"t/${PINNED.replaceAll('.', '\\.')} `))
    assert.equal(existsSync(probed), false, 'mock startup must not execute the official binary')
  } finally {
    proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
