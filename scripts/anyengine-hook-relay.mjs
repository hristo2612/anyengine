#!/usr/bin/env node
// Claude Code hook relay for the `anyengine` runtime.
//
// Wired into the per-thread `--settings` file as
//   node anyengine-hook-relay.mjs <threadId>
// for every hook event. Reads the hook JSON from stdin, POSTs it to the
// runtime's loopback hook server (URL + token come from the PTY environment,
// never from a file) and prints the server's reply — if any — to stdout so
// Claude Code applies it (PreToolUse permission decisions).
//
// Fails open (exit 0, no output) on any relay error so a broken relay can
// never wedge the TUI; the runtime notices a missing hook by other means
// (Notification fallback, turn timeout).
const url = process.env.ANYENGINE_PTY_HOOK_URL
const token = process.env.ANYENGINE_PTY_HOOK_TOKEN
const threadId = process.argv[2] ?? ''

async function main() {
  if (!url || !token) return
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  let hook
  try {
    hook = JSON.parse(raw)
  } catch {
    return
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anyengine-hook-token': token },
    body: JSON.stringify({ threadId, hook }),
  }).catch(() => null)
  if (!response) return
  const body = await response.text().catch(() => '')
  if (response.ok && body.trim()) process.stdout.write(body)
}

main().catch(() => {
  process.exitCode = 0
})
