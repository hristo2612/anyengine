import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { proofKey, sameKey } from '../src/degraded.mjs'
import { codexBinaryVersionCached } from '../src/proof-versions.mjs'
import { removeTempDirs, tempDir } from './helpers/tmp.mjs'

after(removeTempDirs)

test('selected-child version probe ignores other resolvers and fails closed when unreadable', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const root = await tempDir('proof-selected-')
  const selected = join(root, 'selected-codex')
  const other = join(root, 'other-codex')
  const writeVersion = (path: string, version: string) => {
    writeFileSync(path, `#!/bin/sh\nprintf "codex-cli ${version}\\n"\n`, { mode: 0o700 })
    execFileSync(path, ['--version'], { stdio: 'ignore' })
  }
  writeVersion(selected, '0.161.0-selected')
  writeVersion(other, '0.161.0-other')
  const prior = process.env.ANYENGINE_REAL_CODEX
  process.env.ANYENGINE_REAL_CODEX = other
  t.after(() => {
    if (prior === undefined) delete process.env.ANYENGINE_REAL_CODEX
    else process.env.ANYENGINE_REAL_CODEX = prior
  })
  assert.equal(proofKey(root).codexVersion, '0.161.0-other')
  assert.equal(codexBinaryVersionCached(selected), '0.161.0-selected')
  writeVersion(selected, '0.162.0-selected')
  assert.equal(codexBinaryVersionCached(selected), '0.162.0-selected')
  writeFileSync(selected, '#!/bin/sh\nexit 1\n')
  assert.equal(codexBinaryVersionCached(selected), null)
  assert.equal(codexBinaryVersionCached(join(root, 'missing')), null)
})

test('proof versions observes executable CODEX_REAL instead of an absent bundled version', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const root = await tempDir('proof-real-')
  const binary = join(root, 'fallback-codex')
  writeFileSync(binary, '#!/bin/sh\nprintf "codex-cli 0.161.0-fallback\\n"\n', { mode: 0o700 })
  execFileSync(binary, ['--version'], { stdio: 'ignore' })
  const prior = process.env.CODEX_REAL
  process.env.CODEX_REAL = binary
  t.after(() => {
    if (prior === undefined) delete process.env.CODEX_REAL
    else process.env.CODEX_REAL = prior
  })
  assert.equal(proofKey(root).codexVersion, '0.161.0-fallback')
})

test('proof versions: isolated sandboxed version probe, cached by source, with no inherited credentials', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = await tempDir('proof-versions-')
  const binary = join(root, 'fake-codex')
  const source = join(root, 'version')
  const escapedFile = join(root, 'outside-probe')
  writeFileSync(source, 'codex-cli 0.159.0\n')
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" != '--version' ]; then exit 1; fi
if [ "$HOME" = '${root}' ] || [ ! -d "$CODEX_HOME" ] || [ -n "$OPENAI_API_KEY" ]; then exit 2; fi
mkdir -p "$CODEX_HOME/tmp/arg0"
(printf escaped > '${escapedFile}') 2>/dev/null || :
cat '${source}'
`,
  )
  chmodSync(binary, 0o700)
  // Warm a new executable before the production two-second version timeout.
  mkdirSync(join(root, 'warm/codex'), { recursive: true })
  execFileSync(binary, ['--version'], {
    env: { HOME: join(root, 'warm'), CODEX_HOME: join(root, 'warm/codex'), PATH: '/usr/bin:/bin' },
    stdio: 'ignore',
  })
  unlinkSync(escapedFile) // Warm-up is the test's own unsandboxed fake invocation.
  const app = join(root, 'app')
  mkdirSync(join(app, 'Contents'), { recursive: true })
  writeFileSync(
    join(app, 'Contents/Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>26.928</string></dict></plist>',
  )
  const saved = {
    ANYENGINE_REAL_CODEX: process.env.ANYENGINE_REAL_CODEX,
    ANYENGINE_CHATGPT_APP: process.env.ANYENGINE_CHATGPT_APP,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  }
  try {
    process.env.ANYENGINE_REAL_CODEX = binary
    process.env.ANYENGINE_CHATGPT_APP = app
    process.env.OPENAI_API_KEY = 'must-not-inherit'
    const first = proofKey(root)
    assert.equal(first.codexVersion, '0.159.0')
    assert.equal(first.appVersion, '26.928')
    assert.equal(
      existsSync(escapedFile),
      false,
      'sandbox denies writes outside the private probe home',
    )
    writeFileSync(source, 'codex-cli 0.160.0\n')
    assert.equal(proofKey(root).codexVersion, '0.159.0', 'cached for thirty seconds')
    appendFileSync(binary, '\n# updated binary\n')
    execFileSync(binary, ['--version'], {
      env: {
        HOME: join(root, 'warm'),
        CODEX_HOME: join(root, 'warm/codex'),
        PATH: '/usr/bin:/bin',
      },
      stdio: 'ignore',
    })
    unlinkSync(escapedFile)
    writeFileSync(
      join(app, 'Contents/Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>26.929.1</string></dict></plist>',
    )
    assert.equal(
      proofKey(root).codexVersion,
      '0.160.0',
      'same-path binary update invalidates cache immediately',
    )
    assert.equal(
      proofKey(root).appVersion,
      '26.929.1',
      'same-path app update invalidates cache immediately',
    )
    writeFileSync(join(app, 'Contents/Info.plist'), '{invalid plist')
    writeFileSync(binary, '#!/bin/sh\nexit 1\n')
    const unreadable = proofKey(root)
    assert.equal(unreadable.appVersion, null)
    assert.equal(unreadable.codexVersion, null)
    assert.equal(sameKey(unreadable, unreadable), false, 'failed default reads cannot prove native')
    process.env.ANYENGINE_REAL_CODEX = join(root, 'absent')
    assert.equal(proofKey(root).codexVersion, 'absent')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('proof version never caches apparent success from a timed-out family; changed binary retries', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = await tempDir('proof-deadline-')
  const binary = join(root, 'fake.mjs')
  writeFileSync(binary, 'console.log("codex-cli 0.159.0"); setInterval(()=>{},1000)\n', {
    mode: 0o700,
  })
  assert.equal(codexBinaryVersionCached(binary), null)
  writeFileSync(binary, 'console.log("codex-cli 0.160.0")\n')
  assert.equal(codexBinaryVersionCached(binary), '0.160.0')
})
