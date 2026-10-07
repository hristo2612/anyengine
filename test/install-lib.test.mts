import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_CONFIG } from '../src/anyengine-config.mjs'
import { runDoctor } from '../src/control-doctor.mjs'
import { LayerWriter, readLayers, writeLayers } from '../src/control-layers.mjs'
import { readM2Baseline } from '../src/control-m2-upgrade.mjs'
import { codexCompatVersion } from '../src/util.mjs'
import { killChildren, spawn, waitForOutput } from './helpers/children.mjs'
import { startFakeBackend } from './helpers/fake-backend.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'

after(() => killChildren())

const installLib = resolve('scripts/install-lib.mjs')
const libVerify = resolve('scripts/lib-verify.mjs')
const fakeNpm = resolve('test/fixtures/fake-npm.mjs')
const shim = resolve('scripts/codex-shim')

// A package shaped like this repo: a built adapter whose `selfcheck` imports
// its one runtime dependency and whose `app-server` stays up like a live
// adapter, a compiled test that must not ship, and the permission fix-up
// script install-lib runs after `npm ci`.
function makeSource(root: string): string {
  const source = join(root, 'source')
  for (const dir of ['dist/src', 'dist/test', 'scripts']) {
    mkdirSync(join(source, dir), { recursive: true })
  }
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'anyengine',
      version: '9.9.9',
      type: 'module',
      dependencies: { ws: '^8.0.0' },
    }),
  )
  const { REQUIRED_FIXTURES, REQUIRED_HELPERS } = createRequire(import.meta.url)(
    '../../scripts/lib/startup-schema.mjs',
  )
  for (const entry of [...REQUIRED_FIXTURES, ...REQUIRED_HELPERS]) {
    mkdirSync(join(source, entry, '..'), { recursive: true })
    cpSync(resolve(entry), join(source, entry))
  }
  cpSync(resolve('vendor/claude-code-proxy'), join(source, 'vendor/claude-code-proxy'), {
    recursive: true,
  })
  for (const name of [
    'codex-auth-0.162.0-alpha.2.json',
    'claude-messages-2.1.292.json',
    'claude-posture-2.1.289.json',
    'raine-translation-v0.1.42.json',
  ]) {
    cpSync(resolve('test/fixtures', name), join(source, 'test/fixtures', name))
  }
  writeFileSync(join(source, 'package-lock.json'), '{}\n')
  writeFileSync(join(source, 'LICENSE'), 'MIT\n')
  writeFileSync(join(source, 'dist', 'test', 'x.test.mjs'), '\n')
  writeFileSync(join(source, 'scripts', 'fix-node-pty-permissions.mjs'), '\n')
  writeFileSync(
    join(source, 'dist', 'src', 'adapter.mjs'),
    [
      "import 'ws'",
      "if (process.argv[2] === 'selfcheck') {",
      "  if (process.env.FAKE_ADAPTER_BROKEN === '1') process.exit(1)",
      "  console.log('anyengine selfcheck ok')",
      '}',
      "if (process.argv[2] === 'app-server') {",
      "  console.log('adapter up')",
      '  setInterval(() => {}, 1000)',
      '}',
      '',
    ].join('\n'),
  )
  return source
}

function install(
  root: string,
  source: string,
  version: string | null,
  env: NodeJS.ProcessEnv = {},
  npm = fakeNpm,
  extra: string[] = [],
) {
  const args = [installLib, '--source', source, '--dest-root', join(root, 'lib'), '--npm', npm]
  if (version) args.push('--version', version)
  args.push(...extra)
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: join(root, 'home'), ...env },
  })
}

function versions(root: string): string[] {
  return readdirSync(join(root, 'lib'))
    .filter((name) => !name.startsWith('.'))
    .sort()
}

test('install-lib installs, verifies and points current at the new version', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    mkdirSync(join(root, 'home', '.anyengine'), { recursive: true })
    writeFileSync(join(root, 'shim-fallback.json'), '{}\n')
    const result = install(root, source, 'v1', { FAKE_NPM_ARGV_FILE: join(root, 'npm-argv.jsonl') })
    assert.equal(result.status, 0, result.stderr)
    const lib = join(root, 'lib')
    assert.equal(readlinkSync(join(lib, 'current')), 'v1')
    assert.ok(existsSync(join(lib, 'v1', 'node_modules', 'ws', 'package.json')))
    assert.ok(existsSync(join(lib, 'v1', 'install-manifest.json')))
    const reference = 'vendor/claude-code-proxy'
    assert.equal(
      readFileSync(join(lib, 'v1', reference, 'LICENSE'), 'utf8'),
      readFileSync(resolve(reference, 'LICENSE'), 'utf8'),
      'the port ships its complete upstream license',
    )
    assert.equal(
      readFileSync(join(lib, 'v1', reference, 'UPSTREAM.md'), 'utf8'),
      readFileSync(resolve(reference, 'UPSTREAM.md'), 'utf8'),
      'the installed manifest retains the pinned source provenance',
    )
    for (const name of [
      'codex-auth-0.162.0-alpha.2.json',
      'claude-messages-2.1.292.json',
      'claude-posture-2.1.289.json',
      'raine-translation-v0.1.42.json',
    ]) {
      assert.equal(
        readFileSync(join(lib, 'v1', 'test/fixtures', name), 'utf8'),
        readFileSync(resolve('test/fixtures', name), 'utf8'),
        `the installed validators receive the exact captured contract: ${name}`,
      )
    }
    assert.ok(!existsSync(join(lib, 'v1', 'dist', 'test')), 'only dist/src ships')
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'npm-argv.jsonl'), 'utf8')), [
      'ci',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
    ])
    assert.ok(
      !existsSync(join(root, 'shim-fallback.json')),
      'a verified install clears the fallback marker',
    )
    const verify = spawnSync(process.execPath, [libVerify, join(lib, 'current')], {
      encoding: 'utf8',
    })
    assert.equal(verify.status, 0, verify.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('npm distribution installs from its publishable lockfile without a Git checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    renameSync(join(source, 'package-lock.json'), join(source, 'npm-shrinkwrap.json'))
    const result = install(root, source, null, {}, fakeNpm, ['--no-activate'])
    assert.equal(result.status, 0, result.stderr)
    const lib = join(root, 'lib/9.9.9')
    assert.ok(existsSync(join(lib, 'npm-shrinkwrap.json')))
    assert.ok(!existsSync(join(lib, 'package-lock.json')))
    assert.ok(!existsSync(join(root, 'lib/current')))
    assert.equal(JSON.parse(readFileSync(join(lib, 'install-manifest.json'), 'utf8')).commit, null)
    assert.equal(spawnSync(process.execPath, [libVerify, lib]).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lib-verify names a pruned dependency and an edited file', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    assert.equal(install(root, makeSource(root), 'v1').status, 0)
    const lib = join(root, 'lib', 'v1')
    rmSync(join(lib, 'node_modules', 'ws'), { recursive: true })
    writeFileSync(join(lib, 'LICENSE'), 'changed\n')
    writeFileSync(join(lib, 'vendor/claude-code-proxy/UPSTREAM.md'), 'changed\n')
    const verify = spawnSync(process.execPath, [libVerify, lib], { encoding: 'utf8' })
    assert.equal(verify.status, 1)
    assert.match(verify.stderr, /missing: node_modules\/ws\/package\.json/)
    assert.match(verify.stderr, /changed: LICENSE/)
    assert.match(verify.stderr, /changed: vendor\/claude-code-proxy\/UPSTREAM\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a lib that fails its selfcheck never becomes current', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    assert.equal(install(root, source, 'v1').status, 0)
    const broken = install(root, source, 'v2', { FAKE_ADAPTER_BROKEN: '1' })
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /selfcheck --deep failed/)
    assert.equal(readlinkSync(join(root, 'lib', 'current')), 'v1')
    assert.deepEqual(readdirSync(join(root, 'lib')).sort(), ['current', 'v1'], 'no staging left')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The desktop's adapter is started by the shim through `lib/current`, so its
// argv is whatever the shim makes of that link. The lib is reached through a
// symlinked directory too: the version path a running process shows is the
// resolved one, never the spelling the installer was given.
test('an upgrade keeps the version a shim-launched adapter runs from, and prunes the rest', async () => {
  const real = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  const root = `${real}-link`
  symlinkSync(real, root)
  let running: ReturnType<typeof spawn> | null = null
  try {
    const source = makeSource(root)
    const first = install(root, source, 'v1')
    assert.equal(first.status, 0, first.stderr)
    running = spawn(shim, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        ...process.env,
        HOME: join(root, 'home'),
        ANYENGINE_ADAPTER: join(root, 'lib', 'current', 'dist', 'src', 'adapter.mjs'),
        ANYENGINE_NODE: process.execPath,
        ANYENGINE_RUNTIME_ENV: '/dev/null',
        ANYENGINE_DEBUG_LOG: join(real, 'debug.jsonl'),
      },
    })
    await waitForOutput(running, /adapter up/)
    for (const version of ['v2', 'v3', 'v4']) {
      const result = install(root, source, version)
      assert.equal(result.status, 0, result.stderr)
    }
    assert.equal(readlinkSync(join(root, 'lib', 'current')), 'v4')
    assert.deepEqual(versions(root), ['current', 'v1', 'v3', 'v4'])
  } finally {
    running?.kill('SIGKILL')
    unlinkSync(root)
    rmSync(real, { recursive: true, force: true })
  }
})

test('an upgrade removes nothing when it cannot tell what is running', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    const failing = join(root, 'ps-fails')
    mkdirSync(failing)
    writeFileSync(join(failing, 'ps'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(failing, 'ps'), 0o755)
    const missing = join(root, 'no-ps')
    mkdirSync(missing)
    assert.equal(install(root, source, 'v1').status, 0)
    assert.equal(install(root, source, 'v2').status, 0)
    for (const [version, path] of [
      ['v3', failing],
      ['v4', missing],
    ] as const) {
      const result = install(root, source, version, { PATH: path })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stderr, /cannot list running processes; keeping every installed version/)
    }
    assert.deepEqual(versions(root), ['current', 'v1', 'v2', 'v3', 'v4'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reinstalling a verified version only moves current', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    for (const version of ['v1', 'v2']) assert.equal(install(root, source, version).status, 0)
    const again = install(root, source, 'v1')
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /v1 is already installed and verified/)
    assert.equal(readlinkSync(join(root, 'lib', 'current')), 'v1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a source tree with uncommitted changes is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', source, ...args], { stdio: 'ignore' })
    git('init')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init')
    writeFileSync(join(source, 'stray.txt'), 'uncommitted\n')
    const result = install(root, source, null)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /uncommitted changes/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installed lib carries schema validators and their exact posture and Rust fixtures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-fixtures-'))
  try {
    const source = makeSource(root)
    const required = [
      'test/fixtures/claude-permission-modes.json',
      'test/fixtures/posture-schema.json',
      'crates/anyengine-protocol/fixtures',
    ]
    for (const entry of required) {
      mkdirSync(join(source, entry, '..'), { recursive: true })
      cpSync(resolve(entry), join(source, entry), { recursive: true })
    }
    cpSync(resolve('scripts'), join(source, 'scripts'), { recursive: true })
    cpSync(resolve('dist/src'), join(source, 'dist/src'), { recursive: true })
    // Keep the installation selfcheck fake; validators below use real compiled modules.
    writeFileSync(join(source, 'dist/src/adapter.mjs'), 'console.log("fixture selfcheck")\n')
    const npm = join(root, 'fixture-npm.mjs')
    writeFileSync(
      npm,
      `import ${JSON.stringify(fakeNpm)};
      import {cpSync} from 'node:fs';
      cpSync(${JSON.stringify(resolve('node_modules/smol-toml'))},'node_modules/smol-toml',{recursive:true});`,
    )
    assert.equal(install(root, source, 'v1', {}, npm).status, 0)
    for (const entry of required) assert.ok(existsSync(join(root, 'lib/v1', entry)), entry)
    const result = spawnSync(process.execPath, [libVerify, join(root, 'lib/v1')], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const installed = join(root, 'lib/v1')
    const schema = spawnSync(
      process.execPath,
      [join(installed, 'scripts/check-posture-schema.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          CODEX_REAL: resolve('test/fixtures/fake-codex-schema.mjs'),
          FAKE_SCHEMA_FILE: resolve('test/fixtures/posture-schema.json'),
        },
      },
    )
    assert.equal(schema.status, 0, schema.stderr)
    const generator = join(root, 'rust-fake.mjs')
    writeFileSync(
      generator,
      `import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
      const out=process.argv[process.argv.indexOf('--out')+1];
      const methods=['initialize','thread/start','config/read','mcpServerStatus/list','turn/started','turn/completed'];
      for(const file of ['ClientRequest.ts','ServerNotification.ts'])writeFileSync(join(out,file),methods.map(method=>JSON.stringify({method})).join('\\n').replaceAll(':',': '));`,
    )
    const rust = spawnSync(
      process.execPath,
      [join(installed, 'scripts/check-rust-protocol-fixtures.mjs')],
      { cwd: root, encoding: 'utf8', env: { ...process.env, CODEX_REAL: generator } },
    )
    assert.equal(rust.status, 0, rust.stderr)
    const home = join(root, 'observed-home')
    const codex = join(home, '.codex')
    mkdirSync(codex, { recursive: true })
    const system = fakeSystem(home)
    const binary = join(
      system.app,
      'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    )
    mkdirSync(join(binary, '..'), { recursive: true })
    const official = join(root, 'fake-official.mjs')
    writeFileSync(
      official,
      `import {copyFileSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
      if(process.env.HOME===${JSON.stringify(home)}||process.env.CODEX_HOME===${JSON.stringify(codex)})throw Error('inherited observed home');
      if(!readFileSync(join(process.env.CODEX_HOME,'config.toml'),'utf8').includes('127.0.0.1:1'))throw Error('missing refusing provider');
      let refused=false;try{writeFileSync(${JSON.stringify(join(codex, 'forbidden-write'))},'bad')}catch{refused=true}if(!refused)throw Error('outside write allowed');
      if(process.argv.includes('--version'))console.log('codex-cli ${codexCompatVersion()}');
      else if(process.argv.includes('generate-json-schema'))copyFileSync(${JSON.stringify(resolve('test/fixtures/posture-schema.json'))},join(process.argv[process.argv.indexOf('--out')+1],'codex_app_server_protocol.v2.schemas.json'));
      else if(process.argv.includes('generate-ts'))await import(${JSON.stringify(generator)});
      else throw Error('unexpected official invocation');`,
    )
    writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${official}" "$@"\n`, {
      mode: 0o755,
    })
    const legacy = join(root, 'lib/legacy')
    mkdirSync(join(legacy, 'dist/src'), { recursive: true })
    writeFileSync(
      join(legacy, 'dist/src/adapter.mjs'),
      `throw Error('unguarded legacy adapter executed')`,
    )
    let invoked = 0
    const fixtureExec = system.exec.bind(system)
    system.exec = (command, args, options) => {
      if (args[0] !== join(installed, 'scripts/doctor.mjs'))
        return fixtureExec(command, args, options)
      invoked += 1
      assert.equal(options?.env?.ANYENGINE_ADAPTER, join(installed, 'dist/src/adapter.mjs'))
      // A link swap after admission must not redirect any installed code to an unguarded cohort.
      unlinkSync(join(root, 'lib/current'))
      symlinkSync('legacy', join(root, 'lib/current'))
      try {
        const result = spawnSync(command, args, {
          cwd: root,
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...options?.env,
            ANYENGINE_MOCK: '1',
            ANYENGINE_ROUTE: 'native-codex',
            CODEX_REAL: binary,
            ANYENGINE_RUNTIME_ENV: '/dev/null',
          },
        })
        return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
      } finally {
        unlinkSync(join(root, 'lib/current'))
        symlinkSync('v1', join(root, 'lib/current'))
      }
    }
    const report = await runDoctor(system, root, { codexHome: codex })
    assert.equal(report.length, 20)
    assert.equal(report[0]?.level, 'ok', report[0]?.detail ?? '')
    assert.match(report[0]?.detail ?? '', /Posture schema coverage OK/)
    assert.match(report[0]?.detail ?? '', /check-rust-protocol-fixtures.mjs/)
    assert.equal(invoked, 1)
    assert.deepEqual(
      readdirSync(codex),
      [],
      'all actual version/schema writes remain in private probe homes',
    )
    unlinkSync(join(installed, 'test/fixtures/claude-permission-modes.json'))
    const refused = await runDoctor(system, root, { codexHome: codex })
    assert.equal(refused[0]?.level, 'fail')
    assert.match(refused[0]?.detail ?? '', /unsupported installed doctor.*claude-permission-modes/s)
    assert.equal(invoked, 1, 'missing installed fixture refuses before execution')
    const missing = spawnSync(
      process.execPath,
      [join(installed, 'scripts/check-posture-schema.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          CODEX_REAL: resolve('test/fixtures/fake-codex-schema.mjs'),
          FAKE_SCHEMA_FILE: resolve('test/fixtures/posture-schema.json'),
        },
      },
    )
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /claude-permission-modes/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no-activate stages a verified version; activate uses it without source or npm and isolates markers', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    assert.equal(install(root, source, 'A').status, 0)
    const marker = join(root, 'shim-fallback.json')
    const homeMarker = join(root, 'home/.anyengine/shim-fallback.json')
    mkdirSync(join(homeMarker, '..'), { recursive: true })
    writeFileSync(marker, 'root marker')
    writeFileSync(homeMarker, 'unrelated home marker')
    const staged = install(root, source, 'B', {}, fakeNpm, ['--no-activate'])
    assert.equal(staged.status, 0, staged.stderr)
    assert.match(staged.stdout, /staged.*current unchanged/)
    assert.equal(readlinkSync(join(root, 'lib/current')), 'A')
    assert.ok(existsSync(join(root, 'lib/B/install-manifest.json')))
    assert.equal(readFileSync(marker, 'utf8'), 'root marker')
    rmSync(source, { recursive: true })
    const activated = install(root, source, null, {}, join(root, 'missing-npm'), [
      '--activate',
      'B',
    ])
    assert.equal(activated.status, 0, activated.stderr)
    assert.equal(readlinkSync(join(root, 'lib/current')), 'B')
    assert.ok(existsSync(join(root, 'lib/A')))
    assert.ok(!existsSync(marker))
    assert.equal(readFileSync(homeMarker, 'utf8'), 'unrelated home marker')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('present invalid layer evidence refuses staging/activation/pruning and preserves all versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    for (const v of ['A', 'B']) assert.equal(install(root, source, v).status, 0)
    mkdirSync(join(root, 'state'))
    const path = join(root, 'state/layers.json')
    const bytes = Buffer.concat([
      Buffer.from('{"version":1,"layers":[],"name":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ])
    writeFileSync(path, bytes)
    for (const extra of [['--no-activate'], ['--activate', 'A']]) {
      const result = install(root, source, 'C', {}, fakeNpm, extra)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /recovery|evidence|journal|UTF/i)
      assert.deepEqual(readFileSync(path), bytes)
      assert.deepEqual(versions(root), ['A', 'B', 'current'])
      assert.equal(readlinkSync(join(root, 'lib/current')), 'B')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('staged pruning keeps validated initial/last-good/pending/control pins, including POPPED evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  try {
    const source = makeSource(root)
    for (const v of ['A', 'B', 'C'])
      assert.equal(
        install(root, source, v, {}, fakeNpm, ['--no-activate', '--keep', '8']).status,
        0,
      )
    symlinkSync('C', join(root, 'lib/current'))
    const writer = new LayerWriter(root, null, 'router', 'pins')
    writer.writeSymlink(join(root, 'lib/current'), 'A')
    writer.beginUpgrade()
    writer.writeSymlink(join(root, 'lib/current'), 'C')
    const file = readLayers(root)
    file.recovery = {
      entry: join(root, 'recovery/anyengine-off'),
      controlLib: join(root, 'lib/A'),
      pinnedLibs: [join(root, 'lib/A')],
    }
    writeLayers(root, file)
    writeFileSync(join(writer.layer.rollbackDir, 'POPPED'), '')
    const staged = install(root, source, 'D', {}, fakeNpm, ['--no-activate'])
    assert.equal(staged.status, 0, staged.stderr)
    assert.equal(readlinkSync(join(root, 'lib/current')), 'C')
    assert.deepEqual(versions(root), ['A', 'C', 'D', 'current'])
    assert.match(staged.stdout, /kept A: a layer rolls back/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('M2 staging prepares an M1 pin before pruning and refuses a corrupt private journal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'anyengine-lib-'))
  const backend = await startFakeBackend()
  try {
    const source = makeSource(root)
    cpSync(libVerify, join(source, 'scripts/lib-verify.mjs'))
    assert.equal(install(root, source, 'old').status, 0)
    assert.equal(install(root, source, 'A').status, 0)
    // The router layer deliberately has no current-link pin: only M2 can retain A later.
    new LayerWriter(root, null, 'router', 'm1').writeFile(join(root, 'runtime.env'), 'M1\n', 0o600)
    const config = structuredClone(DEFAULT_CONFIG)
    config.router.port = backend.port
    writeFileSync(join(root, 'config.json'), JSON.stringify(config))
    backend.respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          ok: true,
          version: 'A',
          pid: 41001,
          mode: 'agent',
          faults: { hookErrors: 0, unhandledRejections: 0 },
        }),
      )
    }
    const bin = join(root, 'tools')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'ps'),
      `#!/bin/sh
case "$*" in
  *pgid*) echo '41001 1 41001 Thu Oct 1 00:00:00 2026 node ${join(root, 'lib/A/dist/src/adapter.mjs')} router';;
  *) echo 'fixture idle';;
esac
`,
      { mode: 0o700 },
    )
    const launchctl = join(bin, 'launchctl')
    writeFileSync(launchctl, '#!/bin/sh\necho "pid = 41001"\n', { mode: 0o700 })
    // Use the real newly compiled helper as the installer's M2 source indicator.
    cpSync(
      resolve('dist/src/control-claude-layer.mjs'),
      join(source, 'dist/src/control-claude-layer.mjs'),
    )
    const stage = async (version: string, flags: string[]) => {
      const child = spawn(
        process.execPath,
        [
          installLib,
          '--source',
          source,
          '--dest-root',
          join(root, 'lib'),
          '--npm',
          fakeNpm,
          '--version',
          version,
          ...flags,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
          env: {
            ...process.env,
            HOME: join(root, 'home'),
            CODEX_HOME: join(root, 'home/.codex'),
            ANYENGINE_HOME: join(root, 'home/.codex/anyengine'),
            ANYENGINE_PS: join(bin, 'ps'),
            ANYENGINE_LAUNCHCTL: launchctl,
            PATH: `${bin}:/usr/bin:/bin`,
          },
        },
      )
      let output = ''
      child.stdout?.on('data', (chunk) => {
        output += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        output += String(chunk)
      })
      const [code] = await once(child, 'close')
      return { code, output }
    }
    const first = await stage('B', ['--no-activate'])
    assert.equal(first.code, 0, first.output)
    const baseline = readM2Baseline(root)
    assert.ok(baseline)
    assert.equal(baseline.phase, 'prepared')
    assert.equal(baseline.priorLib, join(root, 'lib/A'))
    const activated = await stage('B', ['--activate', 'B'])
    assert.equal(activated.code, 0, activated.output)
    const later = await stage('C', ['--no-activate'])
    assert.equal(later.code, 0, later.output)
    assert.deepEqual(versions(root), ['A', 'B', 'C', 'current'])
    assert.equal(readlinkSync(join(root, 'lib/current')), 'B')
    assert.equal(backend.requests.filter((request) => request.path === '/health').length, 1)
    const bytes = Buffer.from('{"version":1,"baseline":null}\n')
    writeFileSync(baseline.recoveryJournal, bytes, { mode: 0o600 })
    const refused = await stage('D', ['--no-activate'])
    assert.notEqual(refused.code, 0)
    assert.match(refused.output, /invalid recovery evidence/)
    assert.deepEqual(readFileSync(baseline.recoveryJournal), bytes)
    assert.deepEqual(versions(root), ['A', 'B', 'C', 'current'])
    assert.equal(
      readdirSync(join(root, 'lib')).some((name) => name.startsWith('.staging-')),
      false,
    )
  } finally {
    await backend.close()
    rmSync(root, { recursive: true, force: true })
  }
})
