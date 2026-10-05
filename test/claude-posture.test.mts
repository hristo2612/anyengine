import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderGptAgent } from '../src/claude-agents.mjs'
import { decide, fromClaudePermissionMode, type Posture } from '../src/posture.mjs'
import { sessionKey, translateRequest } from '../src/vendor/claude-code-proxy/request.mjs'
import type { Obj } from '../src/vendor/claude-code-proxy/types.mjs'

interface Denial {
  source: string | null
  advertised: boolean
  errorResult: boolean
  permissionDenied: boolean
  markerUnchanged: boolean
}
interface ModeCapture {
  agentPermissionDenied: boolean
  agentDenialSource: string | null
  parentPermissionMode: string | null
  childPermissionMode: string | null
  agentLoaded: boolean
  childModelObserved: boolean
  readRoundTrip: boolean
  outsideRead: Denial
  write: Denial
  command: Denial
  cleanup: string
  deadline: boolean
  exitCode: number | null
}
interface Fixture {
  claudeVersion: string
  isolation: {
    fakeCredentials: boolean
    loopbackOnly: boolean
    realHomeReadWriteDenied: boolean
    keychainFilesAndMachDenied: boolean
    cleanup: string
  }
  agentTemplate: { fields: string[]; bodyBlank: boolean; source: string }
  modes: Record<string, ModeCapture>
  unexercisedModes: string[]
  picker: {
    menuObserved: boolean
    gptRowObserved: boolean
    builtInRowsObserved: boolean
    composerOnly: boolean
    status: string
    cleanup: string
  }
  opens: Array<{ contract: string; reason: string }>
}
const capture = (): Fixture =>
  JSON.parse(
    readFileSync(
      new URL('../../test/fixtures/claude-posture-2.1.289.json', import.meta.url),
      'utf8',
    ),
  )
const model = {
  id: 'gpt-6.1-sol',
  label: 'GPT 6.1 Sol',
  contextWindow: 100_000,
  lite: false,
  efforts: ['medium'],
}
const where = { cwd: '/fake/project', tmpdir: '/fake/tmp', slashTmp: '/tmp' }

test('real CLI posture fixture publishes only after all isolated owned groups have joined', () => {
  const fixture = capture()
  assert.equal(fixture.claudeVersion, '2.1.289')
  assert.deepEqual(fixture.isolation, {
    fakeCredentials: true,
    loopbackOnly: true,
    realHomeReadWriteDenied: true,
    keychainFilesAndMachDenied: true,
    cleanup: 'all owned groups joined',
  })
  for (const mode of ['default', 'plan', 'dontAsk']) {
    assert.equal(fixture.modes[mode]?.cleanup, 'joined')
    assert.equal(fixture.modes[mode]?.deadline, false)
    assert.equal(fixture.modes[mode]?.exitCode, 0)
  }
  assert.equal(fixture.picker.cleanup, 'joined')
  const serialized = JSON.stringify(fixture)
  for (const forbidden of [
    'sk-ant-',
    '/Users/',
    'ANTHROPIC_API_KEY',
    'transcript_path',
    'tool_input',
  ])
    assert.equal(serialized.includes(forbidden), false)
})

test('actual generated blank-body GPT agents load and inherit default and dontAsk parent modes', () => {
  const fixture = capture()
  assert.deepEqual(fixture.agentTemplate, {
    fields: ['name', 'description', 'model'],
    bodyBlank: true,
    source: 'generated-agent-file',
  })
  for (const mode of ['default', 'dontAsk']) {
    const row = fixture.modes[mode]
    assert.ok(row)
    assert.equal(row.agentLoaded, true, `${mode}: actual agent file must load`)
    assert.equal(row.childModelObserved, true, `${mode}: child must request the GPT model`)
    assert.equal(row.readRoundTrip, true, `${mode}: positive Read control must execute`)
    assert.equal(row.parentPermissionMode, mode)
    assert.equal(
      row.childPermissionMode,
      row.parentPermissionMode,
      'modes are measured from actual hook input',
    )
  }
})

test('real plan refuses Agent launch while dontAsk children deny tools without write or command effects', () => {
  const fixture = capture()
  const plan = fixture.modes.plan
  assert.ok(plan)
  assert.equal(plan.parentPermissionMode, 'plan')
  assert.equal(plan.agentPermissionDenied, true)
  assert.equal(plan.agentDenialSource, 'permission-denied-hook')
  assert.equal(plan.childPermissionMode, null)
  assert.equal(plan.childModelObserved, false)
  assert.equal(plan.readRoundTrip, false)
  for (const tool of ['outsideRead', 'write', 'command'] as const) {
    assert.deepEqual(plan[tool], {
      source: null,
      advertised: false,
      errorResult: false,
      permissionDenied: false,
      markerUnchanged: true,
    })
    assert.ok(fixture.opens.some((entry) => entry.contract === `permission:plan:${tool}`))
  }
  assert.ok(fixture.opens.some((entry) => entry.contract === 'agentInheritance:plan'))
  for (const mode of ['dontAsk']) {
    const row = fixture.modes[mode]
    assert.ok(row)
    for (const tool of ['outsideRead', 'write', 'command'] as const) {
      assert.deepEqual(
        row[tool],
        {
          source: 'native-debug+owned-hook+error-result',
          advertised: true,
          errorResult: true,
          permissionDenied: true,
          markerUnchanged: true,
        },
        `${mode}: ${tool}`,
      )
    }
  }
})

test('real default child preserves the explicit read denial and noninteractive write/command approval boundary', () => {
  const row = capture().modes.default
  assert.ok(row)
  for (const tool of ['outsideRead', 'write', 'command'] as const) {
    assert.deepEqual(
      row[tool],
      {
        source: 'native-debug+owned-hook+error-result',
        advertised: true,
        errorResult: true,
        permissionDenied: true,
        markerUnchanged: true,
      },
      tool,
    )
  }
})

test('picker evidence requires a visible menu with custom and built-in rows; composer labels cannot prove it', () => {
  const fixture = capture(),
    picker = fixture.picker
  if (picker.status === 'proven') {
    assert.equal(picker.menuObserved, true)
    assert.equal(picker.gptRowObserved, true)
    assert.equal(picker.builtInRowsObserved, true)
    assert.equal(picker.composerOnly, false)
    assert.equal(
      fixture.opens.some((entry) => entry.contract === 'pickerMenu'),
      false,
    )
  } else {
    assert.equal(picker.status, 'open')
    assert.equal(picker.menuObserved && picker.gptRowObserved && picker.builtInRowsObserved, false)
    assert.ok(
      fixture.opens.some((entry) => entry.contract === 'pickerMenu' && entry.reason.length > 0),
    )
  }
})

test('agents set no posture override; unexercised modes remain explicit and manual maps conservatively', () => {
  const fixture = capture()
  assert.deepEqual(fixture.unexercisedModes, ['acceptEdits', 'auto', 'bypassPermissions', 'manual'])
  for (const mode of [
    'default',
    'acceptEdits',
    'auto',
    'dontAsk',
    'bypassPermissions',
    'plan',
    'manual',
  ]) {
    const rendered = renderGptAgent(model)
    assert.equal(/^permissionMode:|^tools:|^mcpServers:|^hooks:/m.test(rendered), false)
    assert.ok(fromClaudePermissionMode(mode))
  }
  assert.deepEqual(fromClaudePermissionMode('manual'), fromClaudePermissionMode('default'))
  for (const mode of ['plan', 'dontAsk']) {
    const posture = fromClaudePermissionMode(mode) as Posture
    assert.equal(decide(posture, { kind: 'write', path: '/outside/target' }, where), 'deny')
    assert.equal(decide(posture, { kind: 'unbounded' }, where), 'deny')
  }
})

test('translated mixed-agent tool registries, identities and denial data remain separate', () => {
  const keyA = sessionKey(
    { 'x-claude-code-session-id': 'fake-parent', 'x-claude-code-agent-id': 'fake-agent-a' },
    {},
  )
  const keyB = sessionKey(
    { 'x-claude-code-session-id': 'fake-parent', 'x-claude-code-agent-id': 'fake-agent-b' },
    {},
  )
  assert.notEqual(keyA, keyB)
  const request = (tool: string): Obj => ({
    model: model.id,
    tools: [{ name: tool, input_schema: { type: 'object', properties: {} } }],
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call-owned',
            name: tool,
            input: { file_path: '/outside/target' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-owned',
            is_error: true,
            content: 'FAKE_PERMISSION_DENIED',
          },
        ],
      },
    ],
  })
  const context = (session: string) => ({
    model: {
      requested: model.id,
      upstream: model.id,
      lite: false,
      effort: null,
      efforts: model.efforts,
    },
    sessionKey: session,
  })
  const a = request('Read'),
    b = request('Write'),
    beforeA = structuredClone(a),
    beforeB = structuredClone(b)
  const translatedA = translateRequest(a, context(keyA)),
    translatedB = translateRequest(b, context(keyB))
  assert.deepEqual(
    (translatedA.tools as Obj[]).map((tool) => tool.name),
    ['Read'],
  )
  assert.deepEqual(
    (translatedB.tools as Obj[]).map((tool) => tool.name),
    ['Write'],
  )
  assert.equal(translatedA.prompt_cache_key, keyA)
  assert.equal(translatedB.prompt_cache_key, keyB)
  assert.deepEqual((translatedA.input as Obj[]).at(-1), {
    type: 'function_call_output',
    call_id: 'call-owned',
    output: '[tool execution error]\nFAKE_PERMISSION_DENIED',
  })
  assert.deepEqual(a, beforeA)
  assert.deepEqual(b, beforeB)
})
