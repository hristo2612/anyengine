import assert from 'node:assert/strict'
import test from 'node:test'
import {
  engineForModel,
  formatTranscript,
  injectItemsFor,
  REHOME_HEADER,
  REHOME_TRIM_NOTE,
  rehomeMaxChars,
  transcriptEntriesFromTurns,
} from '../src/rehome.mjs'

// The pure half of mid-thread engine switching: which engine a model belongs
// to, and the transcript carried to it. The wiring is exercised end-to-end
// against the fake child in test/codex-mux.test.mts.

test('engineForModel splits the picker into the three engines', () => {
  for (const id of ['gpt-5.6-sol', 'gpt-6-astra', 'gpt_5', 'o3', 'o4-mini', 'codex-mini-latest'])
    assert.equal(engineForModel(id), 'gpt', id)
  for (const id of ['grok-4.6', 'grok-4.5', 'GROK-4.6', 'grok'])
    assert.equal(engineForModel(id), 'grok', id)
  for (const id of ['sonnet', 'opus', 'haiku', 'fable-5.1', 'claude-sonnet-4', 'sonnet[1m]'])
    assert.equal(engineForModel(id), 'claude', id)
  // An unknown id is served by the Claude runtime, matching routeForModel's
  // treatment of custom / router models.
  assert.equal(engineForModel('glm-5.3'), 'claude')
  assert.equal(engineForModel(''), 'claude')
  assert.equal(engineForModel(null), 'claude')
})

test('transcript entries keep what was said and drop how it was produced', () => {
  const turns = [
    {
      items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'remember BANANA' }] },
        { type: 'reasoning', id: 'r1', summary: ['thinking'], content: ['thinking'] },
        { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed' },
        { type: 'agentMessage', id: 'a1', text: 'OK', phase: null },
      ],
    },
    // The child's `thread/read` turns use the same item shape.
    {
      items: [
        { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'and now?' }] },
        { type: 'agentMessage', id: 'a2', text: 'BANANA' },
        { type: 'agentMessage', id: 'a3', text: '   ' },
      ],
    },
  ]
  assert.deepEqual(transcriptEntriesFromTurns(turns), [
    { role: 'user', text: 'remember BANANA' },
    { role: 'assistant', text: 'OK' },
    { role: 'user', text: 'and now?' },
    { role: 'assistant', text: 'BANANA' },
  ])
  assert.deepEqual(transcriptEntriesFromTurns(null), [])
  assert.deepEqual(transcriptEntriesFromTurns([{ items: 'nope' }]), [])
})

test('a short transcript is carried whole, behind one header', () => {
  const block = formatTranscript([
    { role: 'user', text: 'remember BANANA' },
    { role: 'assistant', text: 'OK' },
  ])
  assert.ok(block)
  assert.ok(block.startsWith(REHOME_HEADER))
  assert.ok(block.includes('user: remember BANANA'))
  assert.ok(block.includes('assistant: OK'))
  assert.ok(!block.includes(REHOME_TRIM_NOTE))
  // Nothing to carry on the very first turn of a thread.
  assert.equal(formatTranscript([]), null)
})

test('an over-long transcript keeps the first ask, the tail, and says so', () => {
  const entries = [
    { role: 'user' as const, text: 'FIRST-ASK remember the codeword BANANA' },
    ...Array.from({ length: 200 }, (_, index) => ({
      role: (index % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user',
      text: `filler ${index} ${'x'.repeat(200)}`,
    })),
    { role: 'assistant' as const, text: 'LAST-ANSWER the codeword is BANANA' },
  ]
  const block = formatTranscript(entries, 2_000)
  assert.ok(block)
  assert.ok(block.length < 2_600, `bounded, got ${block.length}`)
  assert.ok(block.startsWith(REHOME_HEADER))
  assert.ok(block.includes('FIRST-ASK'), 'the first user message survives')
  assert.ok(block.includes('LAST-ANSWER the codeword is BANANA'), 'the tail survives')
  assert.ok(block.includes(REHOME_TRIM_NOTE), 'and the gap is declared')
})

test('the transcript cap is configurable and falls back to the default', () => {
  const env = { ANYENGINE_REHOME_MAX_CHARS: '4096' } as NodeJS.ProcessEnv
  assert.equal(rehomeMaxChars(env), 4096)
  assert.equal(rehomeMaxChars({ ANYENGINE_REHOME_MAX_CHARS: '0' } as NodeJS.ProcessEnv), 12_000)
  assert.equal(rehomeMaxChars({ ANYENGINE_REHOME_MAX_CHARS: 'nope' } as NodeJS.ProcessEnv), 12_000)
  assert.equal(rehomeMaxChars({} as NodeJS.ProcessEnv), 12_000)
})

test('the injected form is one Responses user message', () => {
  assert.deepEqual(injectItemsFor('hello'), [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  ])
})
