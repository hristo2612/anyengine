import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const check = resolve('scripts/check-rust-protocol-fixtures.mjs')

// A generator that verifies its isolated homes before emitting fixture methods.
function fakeGenerator(dir: string): string {
  const path = join(dir, 'codex')
  const methods = [
    'initialize',
    'thread/start',
    'config/read',
    'mcpServerStatus/list',
    'turn/started',
    'turn/completed',
  ]
  const body = methods.map((method) => `"method": "${method}"`).join(' ')
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      '[ "$HOME" != "$FAKE_CALLER_HOME" ] && [ "$CODEX_HOME" != "$FAKE_CALLER_CODEX" ] && [ -d "$HOME" ] && [ -d "$CODEX_HOME" ] || exit 2',
      'out=""; while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done',
      `printf '%s' '${body}' > "$out/ClientRequest.ts"`,
      `printf '%s' '${body}' > "$out/ServerNotification.ts"`,
      '',
    ].join('\n'),
  )
  chmodSync(path, 0o755)
  return path
}

test('the fixture drift check generates in a throwaway CODEX_HOME', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anyengine-fixtures-'))
  try {
    const probes = join(dir, 'probes')
    mkdirSync(probes)
    const result = spawnSync(process.execPath, [check], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_REAL: fakeGenerator(dir),
        TMPDIR: probes,
        FAKE_CALLER_HOME: process.env.HOME,
        FAKE_CALLER_CODEX: process.env.CODEX_HOME,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readdirSync(probes), [], 'owned probe homes removed afterwards')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
