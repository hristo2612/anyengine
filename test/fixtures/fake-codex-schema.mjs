#!/usr/bin/env node
// Stand-in for `codex app-server generate-json-schema --experimental --out DIR`
// in the posture schema check's tests: writes FAKE_SCHEMA_FILE as the v2 bundle.
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[process.argv.indexOf('--out') + 1]
copyFileSync(process.env.FAKE_SCHEMA_FILE, join(out, 'codex_app_server_protocol.v2.schemas.json'))

if (process.env.FAKE_FORBIDDEN_HOME === process.env.HOME) {
  console.error('schema inherited caller HOME')
  process.exitCode = 2
}
if (process.env.FAKE_SCHEMA_FAIL) {
  console.error('fixture generation failed')
  process.exitCode = 3
}
