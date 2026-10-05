#!/usr/bin/env node
// Stand-in for the vendor-bundled `codex` the shim execs when the adapter
// cannot start. Answers `--version` without recording anything; otherwise
// records {tag, argv} to FAKE_CODEX_ARGV_FILE, binds a unix socket when asked
// to listen on one, and stays up.
import { renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'

if (process.argv.includes('--version')) {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.0.0-fake'}\n`)
  process.exit(0)
}
if (process.env.FAKE_CODEX_ARGV_FILE) {
  const pending = `${process.env.FAKE_CODEX_ARGV_FILE}.${process.pid}.tmp`
  writeFileSync(
    pending,
    JSON.stringify({ tag: process.env.FAKE_CODEX_TAG ?? null, argv: process.argv.slice(2) }),
    { flag: 'wx' },
  )
  // Readers use this receipt as readiness; publish only the complete JSON.
  renameSync(pending, process.env.FAKE_CODEX_ARGV_FILE)
}
const listenIdx = process.argv.indexOf('--listen')
const listen = listenIdx >= 0 ? (process.argv[listenIdx + 1] ?? '') : ''
if (listen.startsWith('unix://')) {
  const path =
    listen === 'unix://'
      ? `${process.env.CODEX_HOME}/app-server-control/app-server-control.sock`
      : listen.slice('unix://'.length)
  net.createServer().listen(path, () => process.stderr.write(`listening on ${path}\n`))
} else {
  process.stdin.resume()
}
