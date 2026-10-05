import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  BUNDLED_CODEX_LAYOUTS,
  bundledCodexCandidates,
  DEFAULT_CHATGPT_APP,
  reportNativeCodex,
  resolveBundledCodex,
  resolveNativeCodex,
} from '../src/bundled-codex.mjs'

const shim = resolve('scripts/codex-shim')
const PIN = /DEFAULT_COMPAT_VERSION="([^"]+)"/.exec(readFileSync(shim, 'utf8'))?.[1]

// A codex that reports `codex-cli <version>`, so a --version through the shim
// says which candidate the shim picked.
function fakeCodex(path: string, version: string, mode = 0o755): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho "codex-cli ${version}"\n`)
  chmodSync(path, mode)
  return path
}

function shimVersion(env: NodeJS.ProcessEnv): string {
  return shimRun(['--version'], env).stdout.trim()
}

function shimRun(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(shim, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      ANYENGINE_RUNTIME_ENV: '/dev/null',
      ANYENGINE_ROUTE: '',
      ANYENGINE_RUNTIME_TYPE: '',
      ANYENGINE_COMPAT_VERSION: '',
      ...env,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return result
}

test('the layouts are tried newest first, the one the app spawns ahead of its wrapper', () => {
  assert.deepEqual(BUNDLED_CODEX_LAYOUTS, [
    'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    'Contents/Resources/codex-cli/bin/codex',
    'Contents/Resources/codex',
  ])
  assert.equal(DEFAULT_CHATGPT_APP, '/Applications/ChatGPT.app')
  assert.deepEqual(bundledCodexCandidates({ ANYENGINE_CHATGPT_APP: '/x/App.app' }), [
    '/x/App.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/x/App.app/Contents/Resources/codex-cli/bin/codex',
    '/x/App.app/Contents/Resources/codex',
  ])
})

// Parity: the shim carries a bash copy of the rule. Every combination of the
// three layouts, with ANYENGINE_REAL_CODEX unset, runnable, missing, not
// executable or a directory: the adapter's rule and the shim must pick the
// same codex, or both none. Both places the shim uses it are checked: the
// version it advertises, and the codex it runs for any other command, which
// falls to CODEX_REAL, loudly, only when the rule finds nothing.
test('the shim and the adapter resolve the same codex for every layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-bundled-'))
  try {
    const explicitCases: Array<[string, (dir: string) => string | undefined]> = [
      ['unset', () => undefined],
      ['runnable', (dir) => fakeCodex(join(dir, 'explicit-codex'), '7.0.0-explicit')],
      ['missing', (dir) => join(dir, 'no-such-codex')],
      ['not executable', (dir) => fakeCodex(join(dir, 'plain-file'), '7.0.0-plain', 0o644)],
      ['a directory', (dir) => dir],
    ]
    const codexReal = fakeCodex(join(root, 'codex-real'), '7.0.0-codex-real')
    let cases = 0
    for (let mask = 0; mask < 1 << BUNDLED_CODEX_LAYOUTS.length; mask++) {
      for (const [label, makeExplicit] of explicitCases) {
        const dir = join(root, `case-${mask}-${label.replace(/ /g, '-')}`)
        const app = join(dir, 'ChatGPT.app')
        const versions = new Map<string, string>()
        BUNDLED_CODEX_LAYOUTS.forEach((layout, index) => {
          if (!(mask & (1 << index))) return
          const version = `7.0.0-layout${index}`
          versions.set(fakeCodex(join(app, layout), version), version)
        })
        mkdirSync(dir, { recursive: true })
        const explicit = makeExplicit(dir)
        if (label === 'runnable' && explicit) versions.set(explicit, '7.0.0-explicit')
        const env: NodeJS.ProcessEnv = { ANYENGINE_CHATGPT_APP: app }
        if (explicit !== undefined) env.ANYENGINE_REAL_CODEX = explicit
        const picked = resolveBundledCodex(env)
        const expected = picked.path ? versions.get(picked.path) : PIN
        assert.ok(expected, `${label}, layouts ${mask}: the rule picked ${picked.path}`)
        const shimEnv: NodeJS.ProcessEnv = { ...env }
        if (explicit === undefined) shimEnv.ANYENGINE_REAL_CODEX = ''
        assert.equal(
          shimVersion(shimEnv),
          `codex-cli ${expected} (anyengine)`,
          `${label} ANYENGINE_REAL_CODEX, layouts ${mask.toString(2).padStart(3, '0')}`,
        )
        const passthrough = shimRun(['exec', '--json'], { ...shimEnv, CODEX_REAL: codexReal })
        assert.equal(
          passthrough.stdout.trim(),
          `codex-cli ${picked.path ? expected : '7.0.0-codex-real'}`,
          `passthrough: ${label} ANYENGINE_REAL_CODEX, layouts ${mask.toString(2).padStart(3, '0')}`,
        )
        assert.equal(
          /which the app did not ship/.test(passthrough.stderr),
          picked.path === null,
          `passthrough says so exactly when the app's codex is not found: ${passthrough.stderr}`,
        )
        const stale = label === 'unset' || label === 'runnable' ? null : explicit
        assert.equal(picked.stale, stale, `${label}: stale`)
        cases++
      }
    }
    assert.equal(cases, 40)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the 26.928 layout resolves to the Mach-O the app runs, not its wrapper', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-bundled-'))
  try {
    const app = join(root, 'ChatGPT.app')
    const real = fakeCodex(
      join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
      '0.159.0',
    )
    fakeCodex(join(app, 'Contents/Resources/codex-cli/bin/codex'), '0.159.0')
    // What 26.911 left behind is never preferred over what 26.928 ships.
    fakeCodex(join(app, 'Contents/Resources/codex'), '0.155.0-alpha.2.6')
    assert.deepEqual(resolveBundledCodex({ ANYENGINE_CHATGPT_APP: app }), {
      path: real,
      stale: null,
    })
    // Today's failure: runtime.env still named the 26.911 path after the update.
    const gone = '/Applications/ChatGPT.app/Contents/Resources/codex-that-moved'
    assert.deepEqual(
      resolveBundledCodex({ ANYENGINE_CHATGPT_APP: app, ANYENGINE_REAL_CODEX: gone }),
      { path: real, stale: gone },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the native codex child: exec route, off, mock, explicit, bundled, CODEX_REAL, or nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-native-'))
  try {
    const app = join(root, 'ChatGPT.app')
    const explicit = fakeCodex(join(root, 'explicit'), '1')
    const gone = join(root, 'gone')
    const none = join(root, 'no-app')
    // The codex-exec route runs no child, whatever is named.
    assert.deepEqual(
      resolveNativeCodex({ ANYENGINE_GPT_ROUTE: 'exec', ANYENGINE_REAL_CODEX: explicit }),
      { path: null, stale: null, expected: false },
    )
    // ANYENGINE_NATIVE_CODEX=0 wins over everything, a named codex included.
    assert.deepEqual(
      resolveNativeCodex({ ANYENGINE_NATIVE_CODEX: '0', ANYENGINE_REAL_CODEX: explicit }),
      { path: null, stale: null, expected: false },
    )
    // Mock runs only what a test names, and never looks for the app.
    const bundled = fakeCodex(join(app, BUNDLED_CODEX_LAYOUTS[0] ?? ''), '1')
    assert.deepEqual(resolveNativeCodex({ ANYENGINE_MOCK: '1', ANYENGINE_CHATGPT_APP: app }), {
      path: null,
      stale: null,
      expected: false,
    })
    assert.deepEqual(resolveNativeCodex({ ANYENGINE_MOCK: '1', ANYENGINE_REAL_CODEX: explicit }), {
      path: explicit,
      stale: null,
      expected: true,
    })
    assert.deepEqual(resolveNativeCodex({ ANYENGINE_MOCK: '1', ANYENGINE_REAL_CODEX: gone }), {
      path: null,
      stale: gone,
      expected: false,
    })
    assert.deepEqual(
      resolveNativeCodex({ ANYENGINE_REAL_CODEX: gone, ANYENGINE_CHATGPT_APP: app }),
      { path: bundled, stale: gone, expected: true },
    )
    assert.deepEqual(resolveNativeCodex({ ANYENGINE_CHATGPT_APP: none, CODEX_REAL: explicit }), {
      path: explicit,
      stale: null,
      expected: true,
    })
    assert.deepEqual(resolveNativeCodex({ ANYENGINE_CHATGPT_APP: none }), {
      path: null,
      stale: null,
      expected: true,
    })
    // A CODEX_REAL that cannot run is missing, not a spawn that fails later.
    for (const real of [gone, root, 'codex']) {
      assert.deepEqual(
        resolveNativeCodex({ ANYENGINE_CHATGPT_APP: none, CODEX_REAL: real }),
        { path: null, stale: null, expected: true },
        real,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// What 2026-09-30 lacked: a skipped setting and a missing codex both reach
// the app's log and the debug log.
test('a skipped ANYENGINE_REAL_CODEX and a missing codex are both reported', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-native-report-'))
  const log = join(root, 'debug.jsonl')
  const savedLog = process.env.ANYENGINE_DEBUG_LOG
  const write = process.stderr.write
  const lines: string[] = []
  process.env.ANYENGINE_DEBUG_LOG = log
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const app = join(root, 'no-app')
    reportNativeCodex({ path: '/b/codex', stale: '/a/codex', expected: true })
    reportNativeCodex({ path: null, stale: null, expected: true }, { ANYENGINE_CHATGPT_APP: app })
    reportNativeCodex({ path: null, stale: null, expected: false })
    reportNativeCodex({ path: '/b/codex', stale: null, expected: true })
    assert.equal(lines.length, 2, lines.join(''))
    assert.match(
      lines[0] ?? '',
      /ANYENGINE_REAL_CODEX=\/a\/codex is not an executable file.*running \/b\/codex instead/,
    )
    assert.match(
      lines[1] ?? '',
      /no codex for GPT threads: none of .*no-app\/Contents\/Resources\/codex-cli/,
    )
    const events = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      events.map((event) => event.event),
      ['codex.upstream.staleRealCodex', 'codex.upstream.missing'],
    )
    assert.equal(events[0].configured, '/a/codex')
    assert.equal(events[0].using, '/b/codex')
    assert.equal(events[1].checked.length, 3)
  } finally {
    process.stderr.write = write
    if (savedLog === undefined) delete process.env.ANYENGINE_DEBUG_LOG
    else process.env.ANYENGINE_DEBUG_LOG = savedLog
    rmSync(root, { recursive: true, force: true })
  }
})
