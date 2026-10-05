import assert from 'node:assert/strict'
import test from 'node:test'
import { ptyEnv } from '../src/anyengine-env.mjs'

const input = {
  hookUrl: 'http://127.0.0.1:3000',
  hookToken: 'fixture',
  proxyPort: null,
  keepApiKey: true,
}
const source = {
  PATH: '/fixture/bin',
  HOME: '/fixture/home',
  CLAUDE_CONFIG_DIR: '/fixture/config',
  NODE_OPTIONS: 'fixture',
  HTTPS_PROXY: 'fixture',
  CLAUDE_CODE_USE_BEDROCK: 'fixture',
  ANTHROPIC_API_KEY: 'fixture',
  AWS_SECRET_ACCESS_KEY: 'fixture',
  UNRELATED_SECRET: 'fixture',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'true',
}

test('PTY environment: bounded children cannot inherit injection controls or ordinary secrets', () => {
  const env = ptyEnv(input, source)
  for (const key of [
    'NODE_OPTIONS',
    'HTTPS_PROXY',
    'CLAUDE_CODE_USE_BEDROCK',
    'ANTHROPIC_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'UNRELATED_SECRET',
  ]) {
    assert.equal(env[key], undefined, key)
  }
  assert.equal(env.HOME, '/fixture/home')
  assert.equal(env.ANYENGINE_PTY_HOOK_TOKEN, 'fixture')
})

test('PTY environment: prompt suggestions stay off despite inherited composer settings', () => {
  assert.equal(ptyEnv(input, source).CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false')
})

for (const shell of ['exec', 'none', 'bash'] as const) {
  test(`PTY environment: ${shell} keeps appropriate ordinary environment without steering controls`, () => {
    const options = { ...input, shell }
    const env = ptyEnv(options, source)
    assert.equal(env.AWS_SECRET_ACCESS_KEY, shell === 'bash' ? 'fixture' : undefined)
    assert.equal(env.UNRELATED_SECRET, shell === 'bash' ? 'fixture' : undefined)
    for (const key of [
      'NODE_OPTIONS',
      'HTTPS_PROXY',
      'CLAUDE_CODE_USE_BEDROCK',
      'ANTHROPIC_API_KEY',
    ])
      assert.equal(env[key], undefined, key)
    assert.equal(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false')
  })
}
