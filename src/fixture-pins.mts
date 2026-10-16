// The captured fixtures an installed library ships and checks against, named
// once. The doctor, the Claude Code update gate, install-lib, the startup suite
// identity and the posture capture all read these names, and package.json
// `files` lists the same paths (test/fixture-pins.test.mts keeps it in step).
// Refreshing a capture means: run its capture script against the new binary,
// then change the version here.

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
