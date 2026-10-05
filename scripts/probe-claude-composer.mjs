#!/usr/bin/env node
// Zero-spend real-Claude composer capture. Isolated config, loopback fake API,
// sandbox-exec denies external networking and all writes outside probe state.
//
//   node scripts/probe-claude-composer.mjs <claude> $TMPDIR/<task>/<run> <scenario>
//
// Scenarios: manual, plan, acceptEdits, auto, wrapped, collapsed, trust-submit
// and broken-mcp submit through production PtyScreen -> waitForComposer ->
// pasteAndSubmit; CAPTURE_ONLY=1 only captures them. theme, trust, mcp, offer
// and offer-<mode> capture a dialog. Each capture is { lines, typed }, as
// PtyScreen.rows() reads it. Layout variants: PROBE_TUI=fullscreen,
// PROBE_ALT_SCREEN=1 (alternate screen on) and PROBE_PROMPT_SUGGESTIONS=1.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PtyScreen, parseStartupPrompt, pasteAndSubmit } from '../dist/src/anyengine-screen.mjs'
import { waitForComposer } from '../dist/src/anyengine-startup.mjs'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const [binaryArg, stateArg, scenario = 'manual'] = process.argv.slice(2)
assert.ok(binaryArg && stateArg)
const binary = realpathSync(binaryArg)
const state = resolve(stateArg)
// A run's state is a folder inside a task folder of TMPDIR, never a top-level entry.
assert.ok(dirname(state).startsWith(`${realpathSync(process.env.TMPDIR)}/`))
mkdirSync(state, { recursive: false })
const home = join(state, 'home'),
  config = join(home, '.claude'),
  cwd = join(state, 'project')
for (const dir of [config, cwd, join(home, 'Desktop'), join(state, 'tmp')])
  mkdirSync(dir, { recursive: true })
const fakeKey = 'sk-ant-api03-composer-probe-fake-only'
const requestedMode = scenario.replace(/^offer-/, '')
const mode = ['plan', 'acceptEdits', 'auto'].includes(requestedMode) ? requestedMode : 'default'
const cfg = {
  hasCompletedOnboarding: true,
  lastOnboardingVersion: '2.1.287',
  theme: 'dark',
  customApiKeyResponses: { approved: [fakeKey.slice(-20)], rejected: [] },
  projects: { [cwd]: { hasTrustDialogAccepted: !['trust', 'trust-submit'].includes(scenario) } },
}
if (scenario === 'theme') delete cfg.hasCompletedOnboarding
for (const file of [join(home, '.claude.json'), join(config, '.claude.json')])
  writeFileSync(file, JSON.stringify(cfg))
// PROBE_TUI=fullscreen adds the operator's settings shape: the fullscreen TUI,
// with the theme and effort level it was reported with.
const tui = process.env.PROBE_TUI === 'fullscreen' ? { tui: 'fullscreen', effortLevel: 'high' } : {}
writeFileSync(
  join(config, 'settings.json'),
  JSON.stringify({
    permissions: { defaultMode: mode },
    skipDangerousModePermissionPrompt: true,
    theme: 'dark',
    ...tui,
  }),
)
if (scenario === 'mcp')
  writeFileSync(
    join(cwd, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'probe-new-server': { command: '/usr/bin/false' } } }),
  )
const profile = [
  '(version 1)(allow default)',
  '(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
  '(deny file-write*)',
  `(allow file-write* (subpath ${JSON.stringify(state)}) (literal "/dev/null") (regex #"^/dev/ttys"))`,
  `(deny file-read* ${['.claude', '.claude.json', '.codex', '.anyengine'].map((p) => `(subpath ${JSON.stringify(join(homedir(), p))})`).join(' ')})`,
].join('\n')
const requests = []
const api = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    if (req.url?.includes('count_tokens')) {
      res.end('{"input_tokens":10}')
      return
    }
    if (!req.url?.startsWith('/v1/messages')) {
      res.writeHead(404)
      res.end('{}')
      return
    }
    assert.equal(req.headers['x-api-key'], fakeKey)
    const body = JSON.parse(raw)
    requests.push(body)
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'ZERO_SPEND_PROBE_SUBMITTED' },
      }),
    )
  })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: home,
  USER: 'probe',
  LOGNAME: 'probe',
  SHELL: '/bin/zsh',
  LANG: 'en_US.UTF-8',
  TERM: 'xterm-256color',
  TMPDIR: join(state, 'tmp'),
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_API_KEY: fakeKey,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
}
// The operator's account turns prompt suggestions on through a server-side
// flag; the environment switch draws the same faint "Try ..." placeholder.
const suggestions = process.env.PROBE_PROMPT_SUGGESTIONS === '1'
if (suggestions) env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'true'
// PROBE_ALT_SCREEN=1 lets the fullscreen TUI take the alternate screen, which
// the adapter's PTY turns off.
if (process.env.PROBE_ALT_SCREEN === '1') delete env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
const settingsBefore = readFileSync(join(config, 'settings.json'), 'utf8')
const screen = new PtyScreen(120, 40)
const extra =
  scenario === 'broken-mcp'
    ? [
        '--strict-mcp-config',
        '--mcp-config',
        JSON.stringify({ mcpServers: { 'probe-broken-server': { command: '/usr/bin/false' } } }),
      ]
    : []
const proc = pty.spawn(
  '/usr/bin/sandbox-exec',
  [
    '-p',
    profile,
    binary,
    '--permission-mode',
    mode,
    '--model',
    'sonnet',
    '--disable-slash-commands',
    ...extra,
  ],
  { name: 'xterm-256color', cols: 120, rows: 40, cwd, env },
)
proc.onData((d) => screen.write(d))
let exited = false
const exit = new Promise((r) =>
  proc.onExit((e) => {
    exited = true
    r(e)
  }),
)
const capture = async (name) => {
  const clean = (l) => l.replaceAll(cwd, '<PROJECT>').replaceAll(state, '<STATE>')
  const rows = await screen.rows()
  const lines = rows.lines.map(clean)
  // `typed` blanks faint cells: what the composer reads as input.
  writeFileSync(
    join(state, `${name}.json`),
    JSON.stringify({ lines, typed: rows.typed.map(clean) }, null, 2) + '\n',
  )
  console.log(name + '\n' + lines.filter((l) => l.trim()).join('\n'))
  return lines
}
const until = async (pred) => {
  const end = Date.now() + 20000
  while (Date.now() < end && !exited) {
    const v = await screen.viewport()
    if (pred(v)) return v
    await delay(100)
  }
  await capture('timeout')
  throw Error('condition timeout')
}
let cancel = () => {}
try {
  if (['theme', 'trust', 'mcp', 'offer'].includes(scenario) || scenario.startsWith('offer-')) {
    const pattern =
      {
        theme: /Choose the text style|Choose.*theme|Dark mode/,
        trust: /trust this folder/,
        mcp: /New MCP server/,
        offer: /Make auto mode/,
      }[scenario] ?? /Make auto mode/
    await until((v) => v.some((l) => pattern.test(l)))
    await delay(200)
    await capture(scenario)
  } else {
    if (process.env.CAPTURE_ONLY === '1') {
      let seen = 0
      let declined = 0
      await until((v) => {
        // Capture-only still declines the auto-mode offer, with the parser
        // production uses, so that the idle composer can be reached; like
        // production it waits until the offer has settled before answering.
        const offer = parseStartupPrompt(v)
        if (!offer) seen = 0
        else seen ||= Date.now()
        if (
          offer &&
          /^No, keep/.test(offer.label) &&
          Date.now() - seen > 500 &&
          Date.now() - declined > 1500
        ) {
          declined = Date.now()
          for (const key of offer.keystrokes) proc.write(key)
          return false
        }
        return (
          v.some((l) => /^\s*❯/.test(l)) &&
          v.some((l) => /mode on|edits on|for shortcuts/.test(l)) &&
          (!suggestions || v.some((l) => /❯\s+Try "/.test(l)))
        )
      })
    } else
      await waitForComposer(screen, proc, {
        timeoutMs: 20000,
        cwd,
        stopped: () => exited,
        refusal: () => null,
      })
    await delay(300)
    await capture('idle')
    const prompt =
      scenario === 'collapsed'
        ? Array.from({ length: 30 }, (_, i) => `line ${i} of the safe zero-spend probe`).join('\n')
        : scenario === 'wrapped'
          ? 'longword'.repeat(40)
          : 'hello there'
    // Optional capture-only stage establishes RED with production screen, before
    // the broken readiness implementation is changed.
    if (process.env.CAPTURE_ONLY === '1') {
      proc.write(`\x1b[200~${prompt}\x1b[201~`)
      await until((v) => v.some((l) => /hello there|longword|Pasted text|line 0/.test(l)))
      await capture('pasted')
    } else {
      await waitForComposer(screen, proc, {
        timeoutMs: 10000,
        stopped: () => exited,
        refusal: () => null,
      })
      cancel = pasteAndSubmit(proc, prompt, undefined, {
        beforeWrite: async (phase) => {
          await waitForComposer(screen, proc, {
            timeoutMs: 10000,
            stopped: () => exited,
            refusal: () => null,
            ...(phase === 'submit' ? { expectedPrompt: prompt } : {}),
          })
          if (phase === 'submit') await capture('pasted')
        },
        onError: (e) => {
          console.error(e.message)
        },
        onSubmitted: () => console.log('ENTER_SENT'),
      })
      await until(() =>
        requests.some((r) =>
          JSON.stringify(r.messages).includes(JSON.stringify(prompt).slice(1, -1)),
        ),
      )
      assert.equal(readFileSync(join(config, 'settings.json'), 'utf8'), settingsBefore)
      console.log('SUBMITTED_TO_FAKE_API')
      writeFileSync(
        join(state, 'result.json'),
        JSON.stringify(
          {
            scenario,
            submitted: true,
            requests: requests.length,
            settingsUnchanged: true,
            externalNetwork: 'sandbox denied',
            paidRequests: 0,
          },
          null,
          2,
        ) + '\n',
      )
    }
  }
} catch (error) {
  await capture('failure')
  throw error
} finally {
  cancel()
  if (!exited) proc.kill()
  await exit
  screen.dispose()
  api.closeAllConnections()
  await new Promise((r) => api.close(r))
}
