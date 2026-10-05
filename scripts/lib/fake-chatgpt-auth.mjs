// A fake ChatGPT login for the zero-spend codex probes (capture-codex-spawn,
// and the differential gate of the switch-on). It writes <codexHome>/auth.json
// in the shape codex's own `login` writes for a ChatGPT account, with unsigned
// JWTs (alg "none") that no server would ever accept: codex
// only decodes the id token's claims, it does not verify them, and every probe
// that uses this login runs with outbound traffic denied and a loopback fake
// backend, so nothing is sent anywhere real.
//
// Field names come from the installed codex, never from a real auth.json:
// `auth_mode` "chatgpt" (the schema's AuthMode), `OPENAI_API_KEY`, `tokens`
// {id_token, access_token, refresh_token, account_id}, `last_refresh`, and the
// id token's `https://api.openai.com/auth` claims (chatgpt_plan_type,
// chatgpt_account_id, chatgpt_user_id). `codex login status` in the probe home
// reads the file without the network and must report a ChatGPT login.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const YEAR_S = 365 * 24 * 60 * 60

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

// An unsigned JWT carrying `payload`. Its third segment is a placeholder, not
// a signature: codex 0.159 refuses a token whose signature segment is empty
// ("invalid ID token format"), though it never checks what is there.
export function fakeJwt(payload) {
  const placeholder = Buffer.from('unsigned').toString('base64url')
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(payload)}.${placeholder}`
}

// Writes the login (0600) and returns its path. `now` pins the clock (seconds
// and last_refresh) for a caller that wants the same bytes twice.
export function writeFakeChatgptAuth(codexHome, options = {}) {
  const accountId = options.accountId ?? 'acct-anyengine-probe'
  const plan = options.plan ?? 'pro'
  const now = options.now ?? new Date()
  const iat = Math.floor(now.getTime() / 1000)
  const claims = {
    iat,
    exp: iat + YEAR_S,
    email: 'probe@example.invalid',
    'https://api.openai.com/auth': {
      chatgpt_plan_type: plan,
      chatgpt_account_id: accountId,
      chatgpt_user_id: 'user-anyengine-probe',
    },
  }
  const auth = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt(claims),
      access_token: fakeJwt({ ...claims, scp: ['openid', 'profile', 'email'] }),
      refresh_token: 'rt-anyengine-probe',
      account_id: accountId,
    },
    last_refresh: now.toISOString(),
  }
  mkdirSync(codexHome, { recursive: true })
  const path = join(codexHome, 'auth.json')
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}
