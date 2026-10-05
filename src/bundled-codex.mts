import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { codexExecRouteEnabled, debugLog } from './util.mjs'

// Which codex the adapter, the shim and doctor run: one rule, three callers.
// scripts/codex-shim carries a bash copy (it stays dependency-free), and
// test/bundled-codex.test.mts runs both over every layout below, so the two
// cannot drift apart.
//
// 1. ANYENGINE_REAL_CODEX, while it names an executable file.
// 2. ChatGPT.app's own codex (the app at ANYENGINE_CHATGPT_APP, default
//    /Applications/ChatGPT.app), in each layout the app has shipped, newest
//    first.
//
// An ANYENGINE_REAL_CODEX that names nothing runnable is skipped, never
// obeyed: ChatGPT.app 26.928 moved the binary a live runtime.env named, and
// the adapter spawned the old path, failed with ENOENT and served the app
// without GPT, silently. Skipping it is never silent either: the adapter says
// so in the app log and the debug log (reportNativeCodex), the shim does the
// same before it execs a codex itself, and `npm run doctor` fails until the
// setting goes.
export const DEFAULT_CHATGPT_APP = '/Applications/ChatGPT.app'

export const BUNDLED_CODEX_LAYOUTS: readonly string[] = [
  // 26.928 and later: the Mach-O the app spawns itself (its log names it in
  // `stdio_transport_spawned executablePath=`), so a child started from here
  // is the process the app would have run.
  'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  // 26.928 and later: the package's declared entrypoint (codex-package.json),
  // a /bin/sh wrapper that resolves its own symlinks and execs the Mach-O
  // above. It adds a shell and nothing else, so it only comes second: for a
  // later layout that renames the inner app but keeps this entrypoint.
  'Contents/Resources/codex-cli/bin/codex',
  // 26.911 and earlier.
  'Contents/Resources/codex',
]

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function bundledCodexCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const app = env.ANYENGINE_CHATGPT_APP || DEFAULT_CHATGPT_APP
  return BUNDLED_CODEX_LAYOUTS.map((layout) => join(app, layout))
}

export interface BundledCodex {
  // What to run, or null when nothing resolves.
  path: string | null
  // ANYENGINE_REAL_CODEX when it names nothing runnable and was skipped.
  stale: string | null
}

export function resolveBundledCodex(env: NodeJS.ProcessEnv = process.env): BundledCodex {
  const explicit = env.ANYENGINE_REAL_CODEX || ''
  if (explicit && isExecutableFile(explicit)) return { path: explicit, stale: null }
  const found = bundledCodexCandidates(env).find(isExecutableFile) ?? null
  return { path: found, stale: explicit || null }
}

export interface NativeCodex extends BundledCodex {
  // Whether this adapter is meant to run a codex child at all.
  expected: boolean
}

const NO_CHILD: NativeCodex = { path: null, stale: null, expected: false }

// The codex the native-codex multiplexer spawns as its child. `npm run doctor`
// asks this same function of the adapter it checks.
export function resolveNativeCodex(env: NodeJS.ProcessEnv = process.env): NativeCodex {
  // gpt-* threads run through the legacy `codex exec` proxy instead.
  if (codexExecRouteEnabled(env)) return NO_CHILD
  // ANYENGINE_NATIVE_CODEX=0 switches the passthrough off entirely, even
  // when ANYENGINE_REAL_CODEX names a binary: the SSH/Remote twin runs this
  // way so it never carries the account's rate-limit state into the App.
  if ((env.ANYENGINE_NATIVE_CODEX ?? '').trim() === '0') return NO_CHILD
  // Auto-detection is off in mock mode (the test suite): a dev machine with
  // the desktop installed must not have its unit tests spawn the real binary.
  if (env.ANYENGINE_MOCK === '1') {
    const explicit = env.ANYENGINE_REAL_CODEX || ''
    if (explicit && isExecutableFile(explicit))
      return { path: explicit, stale: null, expected: true }
    return { path: null, stale: explicit || null, expected: false }
  }
  const bundled = resolveBundledCodex(env)
  // Last resort, as before this rule: a codex the app did not ship, and only
  // one that can run. A CODEX_REAL that cannot is not spawned into an ENOENT;
  // the child is reported missing instead.
  const real = env.CODEX_REAL?.trim() || ''
  const path = bundled.path ?? (isExecutableFile(real) ? real : null)
  return { path, stale: bundled.stale, expected: true }
}

export function resolveNativeCodexBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveNativeCodex(env).path
}

// Never silent: a skipped ANYENGINE_REAL_CODEX, and an expected codex that
// resolves nowhere, both reach the app's log (stderr) and the debug log.
export function reportNativeCodex(choice: NativeCodex, env: NodeJS.ProcessEnv = process.env): void {
  if (choice.stale) {
    debugLog('codex.upstream.staleRealCodex', { configured: choice.stale, using: choice.path })
    process.stderr.write(
      `[anyengine] ANYENGINE_REAL_CODEX=${choice.stale} is not an executable file ` +
        `(an app update moves the bundled codex); ${choice.path ? `running ${choice.path}` : 'no codex found'} instead. ` +
        'Remove it from runtime.env.\n',
    )
  }
  if (choice.expected && !choice.path) {
    const checked = bundledCodexCandidates(env)
    debugLog('codex.upstream.missing', { checked })
    process.stderr.write(
      `[anyengine] no codex for GPT threads: none of ${checked.join(', ')} is executable and ` +
        'CODEX_REAL names no executable file, so GPT threads are unavailable. Run npm run doctor.\n',
    )
  }
}
