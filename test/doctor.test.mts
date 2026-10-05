import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { killChildren, spawn } from './helpers/children.mjs'

after(() => killChildren())

const doctor = resolve('scripts/doctor.mjs')
const installLib = resolve('scripts/install-lib.mjs')
const fakeNpm = resolve('test/fixtures/fake-npm.mjs')

const PINNED = '0.160.0'

// A bundled codex that reports `version`, so no doctor run depends on which
// ChatGPT.app build the machine has. One file per version: runDoctor's default
// is built before an override is applied, and must not overwrite the override.
function fakeBundled(home: string, version: string): string {
  const path = join(home, `bundled-codex-${version}`)
  writeFileSync(path, `#!/bin/sh\necho "codex-cli ${version}"\n`)
  chmodSync(path, 0o755)
  return path
}

function runDoctor(home: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [doctor], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ANYENGINE_MOCK: '1',
      ANYENGINE_RUNTIME_ENV: '/dev/null',
      ANYENGINE_REAL_CODEX: fakeBundled(home, PINNED),
      ...env,
    },
  })
}

test('doctor reports a recorded shim fallback', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const clean = runDoctor(home)
    assert.equal(clean.status, 0, clean.stdout)
    mkdirSync(join(home, '.anyengine'))
    writeFileSync(
      join(home, '.anyengine', 'shim-fallback.json'),
      JSON.stringify({
        ts: '2026-09-15T19:42:05Z',
        kind: 'bundled',
        reason: 'adapter cannot start',
      }),
    )
    const flagged = runDoctor(home)
    assert.equal(flagged.status, 1)
    assert.match(
      flagged.stdout,
      /fail - no shim fallback recorded: 2026-09-15T19:42:05Z: the shim fell back to the bundled codex \(adapter cannot start\)/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor refuses a live adapter that is not a verified lib', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const result = runDoctor(home, { ANYENGINE_ADAPTER: resolve('dist/src/adapter.mjs') })
    assert.equal(result.status, 1)
    assert.match(
      result.stdout,
      /fail - live adapter runs from a verified lib: .* is not an installed lib/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The shim runs ~/.anyengine/lib/current when ANYENGINE_ADAPTER is unset, so
// that is what doctor checks then: the documented install sets no variable.
function installMiniLib(root: string, home: string): string {
  const source = join(root, 'source')
  mkdirSync(join(source, 'dist', 'src'), { recursive: true })
  mkdirSync(join(source, 'scripts'))
  const { REQUIRED_FIXTURES, REQUIRED_HELPERS } = createRequire(import.meta.url)(
    '../../scripts/lib/startup-schema.mjs',
  )
  for (const entry of [...REQUIRED_FIXTURES, ...REQUIRED_HELPERS]) {
    mkdirSync(dirname(join(source, entry)), { recursive: true })
    cpSync(resolve(entry), join(source, entry))
  }
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({ name: 'anyengine', version: '9.9.9', type: 'module' }),
  )
  writeFileSync(join(source, 'package-lock.json'), '{}\n')
  writeFileSync(join(source, 'LICENSE'), 'MIT\n')
  writeFileSync(
    join(source, 'dist', 'src', 'adapter.mjs'),
    "console.log('anyengine selfcheck ok')\n",
  )
  writeFileSync(
    join(source, 'dist', 'src', 'runtime-config.mjs'),
    "export const resolveRuntimeConfig = () => ({ type: 'mock' })\n",
  )
  const lib = join(home, '.anyengine', 'lib')
  execFileSync(
    process.execPath,
    [installLib, '--source', source, '--dest-root', lib, '--version', 'v1', '--npm', fakeNpm],
    { env: { ...process.env, HOME: home }, stdio: 'pipe', encoding: 'utf8' },
  )
  return lib
}

test('doctor checks the default lib when ANYENGINE_ADAPTER is unset', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  const home = join(root, 'home')
  mkdirSync(home)
  try {
    const none = runDoctor(home)
    assert.match(none.stdout, /ok - live adapter runs from a verified lib/, 'no lib installed yet')
    const lib = installMiniLib(root, home)
    const good = runDoctor(home)
    assert.match(good.stdout, /ok - live adapter runs from a verified lib/)
    writeFileSync(join(lib, 'v1', 'LICENSE'), 'edited\n')
    const edited = runDoctor(home)
    assert.equal(edited.status, 1)
    assert.match(edited.stdout, /fail - live adapter runs from a verified lib: changed: LICENSE/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor fails a current link that points at a removed version', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  const home = join(root, 'home')
  try {
    mkdirSync(join(home, '.anyengine', 'lib'), { recursive: true })
    symlinkSync('gone', join(home, '.anyengine', 'lib', 'current'))
    const result = runDoctor(home)
    assert.equal(result.status, 1)
    assert.match(result.stdout, /fail - live adapter runs from a verified lib: .*does not exist/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor flags a pin that no longer matches the bundled codex', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const result = runDoctor(home, { ANYENGINE_REAL_CODEX: fakeBundled(home, '0.199.0') })
    assert.equal(result.status, 1)
    assert.ok(
      result.stdout.includes(
        `fail - compat pin matches the bundled codex: bundled codex is 0.199.0, the repo pins ${PINNED};`,
      ),
      result.stdout,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The shim advertises an explicit ANYENGINE_COMPAT_VERSION over the bundled
// codex, so a stale one outlives every app update: doctor names both.
test('doctor flags an explicit compat version that differs from the bundled codex', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const stale = runDoctor(home, { ANYENGINE_COMPAT_VERSION: '0.153.4' })
    assert.equal(stale.status, 1)
    assert.ok(
      stale.stdout.includes(
        `fail - compat pin matches the bundled codex: ANYENGINE_COMPAT_VERSION=0.153.4 overrides the bundled codex ${PINNED};`,
      ),
      stale.stdout,
    )
    const legacy = runDoctor(home, { CODEX_SHIM_COMPAT_VERSION: '0.153.4' })
    assert.match(
      legacy.stdout,
      /fail - compat pin matches the bundled codex: CODEX_SHIM_COMPAT_VERSION=0\.153\.4 overrides/,
    )
    const same = runDoctor(home, { ANYENGINE_COMPAT_VERSION: PINNED })
    assert.match(same.stdout, /ok - compat pin matches the bundled codex/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A stand-in for the claude, codex or grok CLI: doctor only asks it for --version.
// The shim's own version probe passes through to codex, so that one says codex-cli.
function fakeTool(home: string, name: string): string {
  const path = join(home, `fake-${name}`)
  writeFileSync(path, `#!/bin/sh\necho "${name === 'codex' ? 'codex-cli' : name} 1.0.0"\n`)
  chmodSync(path, 0o755)
  return path
}

// Doctor as the operator's live config runs it: no mock, a real runtime type,
// and a codex child expected (the suite-wide ANYENGINE_NATIVE_CODEX=0 is not
// the live config's).
function runLive(home: string, type: string, env: NodeJS.ProcessEnv = {}) {
  return runDoctor(home, {
    ANYENGINE_MOCK: '',
    ANYENGINE_NATIVE_CODEX: '',
    ANYENGINE_RUNTIME_TYPE: type,
    ANYENGINE_CLI: fakeTool(home, 'claude'),
    CODEX_REAL: fakeTool(home, 'codex'),
    ANYENGINE_GROK_BIN: fakeTool(home, 'grok'),
    ...env,
  })
}

// The live config sets ANYENGINE_RUNTIME_TYPE=anyengine. Doctor once kept its
// own alias table, lacked that name and exited 1 before printing a single check.
test('doctor accepts the anyengine runtime and prints its checks', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const result = runLive(home, 'anyengine')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, /unknown ANYENGINE_RUNTIME_TYPE/)
    assert.match(result.stdout, /^ok - runtime type: anyengine$/m)
    assert.match(result.stdout, /^ok - node >= 24 with stable node:sqlite$/m)
    assert.match(result.stdout, /^ok - claude CLI for the interactive runtime$/m)
    const missing = runLive(home, 'anyengine', { ANYENGINE_CLI: join(home, 'no-such-claude') })
    assert.equal(missing.status, 1)
    assert.match(missing.stdout, /^fail - claude CLI for the interactive runtime: /m)
    assert.match(missing.stdout, /^ok - node >= 24 with stable node:sqlite$/m)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor resolves every adapter alias to the runtime the adapter selects', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const cases: Array<[string, string]> = [
      ['pty', 'anyengine'],
      ['claude-pty', 'anyengine'],
      ['interactive', 'anyengine'],
      ['CODEX-EXEC', 'codex-proxy'],
      ['grok-acp', 'grok'],
      ['sidecar', 'agent-sdk-sidecar'],
    ]
    for (const [alias, type] of cases) {
      const result = runLive(home, alias, { ANTHROPIC_API_KEY: 'unused' })
      assert.equal(result.status, 0, `${alias}: ${result.stdout}${result.stderr}`)
      assert.match(result.stdout, new RegExp(`^ok - runtime type: ${type}$`, 'm'), alias)
    }
    const codexProxy = runLive(home, 'codex-proxy')
    assert.match(codexProxy.stdout, /^ok - real Codex passthrough$/m)
    const grok = runLive(home, 'grok')
    assert.match(grok.stdout, /^ok - grok CLI$/m)
    const noGrok = runLive(home, 'grok', { ANYENGINE_GROK_BIN: join(home, 'no-such-grok') })
    assert.equal(noGrok.status, 1)
    assert.match(noGrok.stdout, /^fail - grok CLI: /m)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The shim launches the real codex for these spellings without the adapter, so
// only the shim (and doctor) know them; the adapter's own table rejects them.
test('doctor still accepts the shim-level native codex spellings', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    for (const alias of ['codex', 'native-codex', 'real']) {
      const result = runLive(home, alias)
      assert.equal(result.status, 0, `${alias}: ${result.stdout}${result.stderr}`)
      assert.match(result.stdout, /^ok - runtime type: codex$/m, alias)
      assert.match(result.stdout, /^ok - real Codex passthrough$/m, alias)
    }
    // The shim's route: ANYENGINE_ROUTE beats ANYENGINE_RUNTIME_TYPE, and the
    // shim ignores the legacy names, so `ANYENGINE_RUNTIME=codex` reaches the
    // adapter, which rejects it.
    const route = runLive(home, 'anyengine', { ANYENGINE_ROUTE: 'codex' })
    assert.match(route.stdout, /^ok - runtime type: codex$/m)
    const legacy = runLive(home, '', {
      ANYENGINE_RUNTIME_TYPE: undefined,
      ANYENGINE_RUNTIME: 'codex',
    })
    assert.match(legacy.stdout, /^fail - runtime type: unknown ANYENGINE_RUNTIME_TYPE: codex$/m)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor honours the legacy runtime variables with the adapter precedence', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const legacy = runLive(home, '', {
      ANYENGINE_RUNTIME_TYPE: undefined,
      ANYENGINE_RUNTIME: 'pty',
    })
    assert.match(legacy.stdout, /^ok - runtime type: anyengine$/m)
    const backend = runLive(home, '', {
      ANYENGINE_RUNTIME_TYPE: undefined,
      ANYENGINE_BACKEND: 'grok',
    })
    assert.match(backend.stdout, /^ok - runtime type: grok$/m)
    // An empty ANYENGINE_RUNTIME_TYPE still wins over the legacy names (the
    // adapter reads them with ??), so the default runtime applies.
    const empty = runLive(home, '', { ANYENGINE_RUNTIME: 'pty', ANTHROPIC_API_KEY: 'unused' })
    assert.match(empty.stdout, /^ok - runtime type: agent-sdk-sidecar$/m)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// One source of truth: doctor asks the adapter it is checking, so an alias only
// that adapter knows resolves, whether it is named by ANYENGINE_ADAPTER or is
// the installed lib the shim runs by default.
test('doctor resolves the runtime type with the adapter it checks', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const fakeLib = (root: string) => {
      mkdirSync(join(root, 'dist', 'src'), { recursive: true })
      writeFileSync(
        join(root, 'dist', 'src', 'runtime-config.mjs'),
        "export const resolveRuntimeConfig = (env) => { if (env.ANYENGINE_RUNTIME_TYPE === 'only-here') return { type: 'mock' }; throw new Error(`unknown ANYENGINE_RUNTIME_TYPE: ${env.ANYENGINE_RUNTIME_TYPE}`) }\n",
      )
    }
    const named = join(home, 'named-lib')
    fakeLib(named)
    const byVariable = runLive(home, 'only-here', {
      ANYENGINE_ADAPTER: join(named, 'dist', 'src', 'adapter.mjs'),
    })
    assert.match(byVariable.stdout, /^ok - runtime type: mock$/m, byVariable.stdout)
    fakeLib(join(home, '.anyengine', 'lib', 'current'))
    const byDefault = runLive(home, 'only-here')
    assert.match(byDefault.stdout, /^ok - runtime type: mock$/m, byDefault.stdout)
    // And the checkout's own adapter does not know that alias.
    rmSync(join(home, '.anyengine'), { recursive: true, force: true })
    const checkout = runLive(home, 'only-here')
    assert.match(
      checkout.stdout,
      /^fail - runtime type: unknown ANYENGINE_RUNTIME_TYPE: only-here$/m,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor reports an unknown runtime type as a failing check, not a crash', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const result = runLive(home, 'bogus')
    assert.equal(result.status, 1)
    assert.match(result.stdout, /^fail - runtime type: unknown ANYENGINE_RUNTIME_TYPE: bogus$/m)
    assert.match(result.stdout, /^ok - node >= 24 with stable node:sqlite$/m)
    assert.equal(result.stderr, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor reports an adapter it cannot load as a failing check, not a crash', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const result = runLive(home, 'anyengine', {
      ANYENGINE_ADAPTER: join(home, 'nowhere', 'dist', 'src', 'adapter.mjs'),
    })
    assert.equal(result.status, 1)
    assert.match(
      result.stdout,
      /^fail - runtime type: cannot load the adapter's runtime-config \(.*runtime-config\.mjs.*\)$/m,
    )
    assert.match(result.stdout, /^ok - node >= 24 with stable node:sqlite$/m)
    assert.match(result.stdout, /^fail - built adapter exists: /m)
    assert.equal(result.stderr, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ANYENGINE_PROVIDER and ANYENGINE_AGENT_LOOP select a runtime when no type is
// set, and mock wins over them: doctor takes all of that from the adapter.
test('doctor follows the adapter into the provider and loop selection', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const codexLoop = { ANYENGINE_PROVIDER: 'codex', ANYENGINE_AGENT_LOOP: 'codex-jsonl-proxy' }
    for (const type of [undefined, '']) {
      const result = runLive(home, '', { ...codexLoop, ANYENGINE_RUNTIME_TYPE: type })
      assert.equal(result.status, 0, `${type}: ${result.stdout}${result.stderr}`)
      assert.match(result.stdout, /^ok - runtime type: codex-proxy$/m)
      assert.match(result.stdout, /^ok - real Codex passthrough$/m)
      assert.doesNotMatch(result.stdout, /Claude auth surface/)
    }
    const explicit = runLive(home, 'anyengine', codexLoop)
    assert.match(explicit.stdout, /^ok - runtime type: anyengine$/m)
    const claude = runLive(home, '', {
      ANYENGINE_RUNTIME_TYPE: undefined,
      ANYENGINE_PROVIDER: 'claude-code',
      ANTHROPIC_API_KEY: 'unused',
    })
    assert.match(claude.stdout, /^ok - runtime type: agent-sdk-sidecar$/m)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor validates a mock run the way the adapter does', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const mock = runLive(home, 'anyengine', { ANYENGINE_MOCK: '1' })
    assert.equal(mock.status, 0, mock.stdout + mock.stderr)
    assert.match(mock.stdout, /^ok - runtime type: mock$/m)
    assert.doesNotMatch(mock.stdout, /claude CLI/)
    const bogus = runLive(home, 'bogus', { ANYENGINE_MOCK: '1' })
    assert.equal(bogus.status, 1)
    assert.match(bogus.stdout, /^fail - runtime type: unknown ANYENGINE_RUNTIME_TYPE: bogus$/m)
    assert.match(bogus.stdout, /^ok - node >= 24 with stable node:sqlite$/m)
    assert.equal(bogus.stderr, '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A ChatGPT.app with its codex where 26.928 put it.
function fakeApp(home: string, version = PINNED): { app: string; codex: string } {
  const app = join(home, 'ChatGPT.app')
  const codex = join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  mkdirSync(dirname(codex), { recursive: true })
  writeFileSync(codex, `#!/bin/sh\necho "codex-cli ${version}"\n`)
  chmodSync(codex, 0o755)
  return { app, codex }
}

// 2026-09-30: runtime.env named the 26.911 codex after the app moved it, and
// the adapter ran without GPT while every doctor check passed.
test('doctor fails a named codex that an app update moved, and names what runs instead', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const { app, codex } = fakeApp(home)
    const moved = join(app, 'Contents', 'Resources', 'codex')
    const stale = runLive(home, 'anyengine', {
      ANYENGINE_REAL_CODEX: moved,
      ANYENGINE_CHATGPT_APP: app,
    })
    assert.equal(stale.status, 1)
    assert.ok(
      stale.stdout.includes(
        `fail - bundled codex resolves: ANYENGINE_REAL_CODEX=${moved} is not an executable file ` +
          `(an app update moves the bundled codex); the adapter and the shim skip it for ${codex}. ` +
          'Remove it from runtime.env',
      ),
      stale.stdout,
    )
    const fixed = runLive(home, 'anyengine', {
      ANYENGINE_REAL_CODEX: '',
      ANYENGINE_CHATGPT_APP: app,
    })
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr)
    assert.ok(fixed.stdout.includes(`ok - bundled codex resolves: ${codex}\n`), fixed.stdout)
    assert.match(fixed.stdout, /^ok - compat pin matches the bundled codex$/m)
    // The pin is checked against the codex the rule found, not a fixed path.
    const { app: newer } = fakeApp(join(home, 'newer'), '0.199.0')
    const drift = runLive(home, 'anyengine', {
      ANYENGINE_REAL_CODEX: '',
      ANYENGINE_CHATGPT_APP: newer,
    })
    assert.match(
      drift.stdout,
      /^fail - compat pin matches the bundled codex: bundled codex is 0\.199\.0/m,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor fails when a codex child is expected and none resolves', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const none = join(home, 'no-app')
    const missing = runLive(home, 'anyengine', {
      ANYENGINE_REAL_CODEX: '',
      ANYENGINE_CHATGPT_APP: none,
      CODEX_REAL: '',
    })
    assert.equal(missing.status, 1)
    assert.match(
      missing.stdout,
      /^fail - bundled codex resolves: no codex in .*no-app\/Contents\/Resources\/codex-cli\/CodexCLI\.app\/Contents\/MacOS\/codex, .*: GPT threads would fail\./m,
    )
    // CODEX_REAL would run, but it is not the app's codex: still a failure.
    const other = runLive(home, 'anyengine', {
      ANYENGINE_REAL_CODEX: '',
      ANYENGINE_CHATGPT_APP: none,
    })
    assert.equal(other.status, 1)
    assert.match(
      other.stdout,
      /GPT threads would run on CODEX_REAL \(.*fake-codex\), a codex the app did not ship/,
    )
    // No child expected: the SSH twin, a mock run, the codex-exec route.
    for (const off of [
      { ANYENGINE_NATIVE_CODEX: '0' },
      { ANYENGINE_MOCK: '1' },
      { ANYENGINE_GPT_ROUTE: 'exec' },
    ]) {
      const result = runLive(home, 'anyengine', {
        ANYENGINE_REAL_CODEX: '',
        ANYENGINE_CHATGPT_APP: none,
        ...off,
      })
      assert.match(
        result.stdout,
        /^ok - bundled codex resolves: none \(no codex child\)$/m,
        JSON.stringify(off),
      )
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// Doctor takes the rule from the adapter it checks: an installed lib from
// before the rule would still spawn the 26.911 path, and says so here.
test('doctor fails an adapter that predates the layout rule', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const lib = join(home, 'old-lib')
    mkdirSync(join(lib, 'dist', 'src'), { recursive: true })
    writeFileSync(
      join(lib, 'dist', 'src', 'runtime-config.mjs'),
      "export const resolveRuntimeConfig = () => ({ type: 'mock' })\n",
    )
    const result = runLive(home, 'anyengine', {
      ANYENGINE_ADAPTER: join(lib, 'dist', 'src', 'adapter.mjs'),
    })
    assert.equal(result.status, 1)
    assert.match(
      result.stdout,
      /^fail - bundled codex resolves: cannot load the adapter's bundled-codex \(.*old-lib\/dist\/src\/bundled-codex\.mjs: ERR_MODULE_NOT_FOUND\)$/m,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The shim and the adapter take the pre-rebrand CLAUDE_CODEX_* spellings, so
// doctor reads them too, through the checked adapter's env-compat module.
test('doctor applies legacy CLAUDE_CODEX_* names the way the adapter does', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-'))
  try {
    const { app, codex } = fakeApp(home)
    const moved = join(app, 'Contents', 'Resources', 'codex')
    const legacy = (value: string) =>
      runLive(home, 'anyengine', {
        ANYENGINE_REAL_CODEX: undefined,
        CLAUDE_CODEX_REAL_CODEX: value,
        ANYENGINE_CHATGPT_APP: app,
      })
    const stale = legacy(moved)
    assert.equal(stale.status, 1)
    assert.match(
      stale.stdout,
      /^fail - bundled codex resolves: ANYENGINE_REAL_CODEX=.*Contents\/Resources\/codex is not an executable file/m,
    )
    const named = fakeBundled(home, PINNED)
    const good = legacy(named)
    assert.equal(good.status, 0, good.stdout + good.stderr)
    assert.ok(good.stdout.includes(`ok - bundled codex resolves: ${named}\n`), good.stdout)
    // The new name still wins over the old one.
    const both = runLive(home, 'anyengine', {
      ANYENGINE_REAL_CODEX: named,
      CLAUDE_CODEX_REAL_CODEX: moved,
      ANYENGINE_CHATGPT_APP: app,
    })
    assert.equal(both.status, 0, both.stdout)
    assert.ok(!both.stdout.includes(codex), 'the app layout was not needed')
    // An adapter without the module: a legacy name set is a failure, not a pass.
    const lib = join(home, 'no-compat-lib')
    mkdirSync(join(lib, 'dist', 'src'), { recursive: true })
    const broken = runLive(home, 'anyengine', {
      ANYENGINE_ADAPTER: join(lib, 'dist', 'src', 'adapter.mjs'),
      CLAUDE_CODEX_REAL_CODEX: named,
    })
    assert.match(
      broken.stdout,
      /^fail - legacy CLAUDE_CODEX_\* settings applied: CLAUDE_CODEX_REAL_CODEX not applied: cannot load the adapter's env-compat/m,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor uses an isolated bundled version probe and preserves caller state', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-isolated-'))
  try {
    const binary = join(home, 'probe-codex')
    const sentinel = join(home, 'protected')
    writeFileSync(sentinel, 'retained')
    writeFileSync(
      binary,
      `#!/bin/sh
if [ "$HOME" = '${home}' ]; then echo 'inherited caller HOME' >&2; exit 2; fi
if (printf changed > '${sentinel}') 2>/dev/null; then echo 'outside write allowed' >&2; exit 3; fi
printf 'codex-cli ${PINNED}\\n'
`,
      { mode: 0o755 },
    )
    const result = runDoctor(home, { ANYENGINE_REAL_CODEX: binary })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor resolves a configured bare CLI through caller PATH before isolating it', () => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-path-'))
  try {
    const tool = fakeTool(home, 'grok')
    const result = runLive(home, 'grok', {
      ANYENGINE_GROK_BIN: 'fake-grok',
      PATH: `${home}:${process.env.PATH}`,
    })
    assert.equal(result.status, 0, `${tool}: ${result.stdout}${result.stderr}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor probes the same official executable only once, including failed probes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'anyengine-doctor-count-'))
  let count = 0
  const server = http.createServer((_req, res) => {
    count += 1
    res.end('fixture')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => new Promise<void>((done) => server.close(() => done())))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const binary = join(home, 'fake.mjs')
  for (const status of [0, 1]) {
    count = 0
    writeFileSync(
      binary,
      `await fetch('http://127.0.0.1:${address.port}');console.log('codex-cli ${PINNED}');process.exit(${status});`,
      { mode: 0o755 },
    )
    const child = spawn(process.execPath, [doctor], {
      env: {
        ...process.env,
        HOME: home,
        ANYENGINE_MOCK: '1',
        ANYENGINE_ROUTE: 'native-codex',
        ANYENGINE_RUNTIME_ENV: '/dev/null',
        ANYENGINE_REAL_CODEX: binary,
        CODEX_REAL: binary,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })
    const [code] = await once(child, 'close')
    assert.equal(code, status, output)
    assert.equal(count, 1, output)
  }
})
