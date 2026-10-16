// The captured fixtures an installed library ships and checks against, named
// in one place. The doctor, the Claude Code update gate, install-lib and the
// posture capture read these names; the startup helper
// (scripts/lib/startup-schema.mjs) and package.json `files` keep copies, and
// test/fixture-pins.test.mts fails when they disagree. To refresh a capture:
// change the version here, build, then run its capture script against that
// exact binary (scripts/AGENTS.md has the steps).

/** Claude Code version the posture and Messages captures were taken from. */
export const CLAUDE_FIXTURE_VERSION = '2.1.301'
/** Codex version the official auth RPC capture was taken from. */
export const CODEX_AUTH_FIXTURE_VERSION = '0.162.0-alpha.17.2'

export const FIXTURE_NAMES = {
  codexAuth: `codex-auth-${CODEX_AUTH_FIXTURE_VERSION}.json`,
  codexAccounts: 'codex-accounts-0.160.0.json',
  claudeMessages: `claude-messages-${CLAUDE_FIXTURE_VERSION}.json`,
  claudePosture: `claude-posture-${CLAUDE_FIXTURE_VERSION}.json`,
  raineTranslation: 'raine-translation-v0.1.42.json',
  claudePermissionModes: 'claude-permission-modes.json',
  postureSchema: 'posture-schema.json',
} as const

export const fixturePath = (name: string): string => `test/fixtures/${name}`

/** Every shipped fixture under test/fixtures, in install order. */
export const SHIPPED_FIXTURES: readonly string[] = [
  FIXTURE_NAMES.claudePermissionModes,
  FIXTURE_NAMES.postureSchema,
  FIXTURE_NAMES.codexAuth,
  FIXTURE_NAMES.codexAccounts,
  FIXTURE_NAMES.claudeMessages,
  FIXTURE_NAMES.claudePosture,
  FIXTURE_NAMES.raineTranslation,
].map(fixturePath)

/** The fixtures the Claude Code (M2) layer needs in an installed library. */
export const M2_FIXTURES: readonly string[] = [
  FIXTURE_NAMES.codexAuth,
  FIXTURE_NAMES.claudeMessages,
  FIXTURE_NAMES.claudePosture,
  FIXTURE_NAMES.raineTranslation,
].map(fixturePath)
