// What the ported Responses writer and Codex input parser do with hostile or
// unlucky input: a surrogate pair cut in half, a crafted item `type`, and
// text built to make a backtracking regex take minutes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCodexRequest, parseEnvironment, sanitizeInputForOpenAI } from '../src/codex-input.mjs'
import { type ResponseSink, ResponsesStream, usageObject } from '../src/responses-stream.mjs'
import { describeToolError, describeToolUse, progressLine } from '../src/tool-display.mjs'

// Well formed exactly when UTF-8 round-trips it: a lone surrogate comes back as U+FFFD.
const isWellFormed = (text: string) => Buffer.from(text, 'utf8').toString('utf8') === text
// How JSON.stringify writes a lone surrogate, which Codex's serde_json rejects.
const LONE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i

const message = (role: string, text: string) => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text }],
})
const user = (text: string) => message('user', text)
// `a` x index, then an emoji whose first half is at `index`, then `b` x rest.
const emojiAt = (index: number, rest: number) => `${'a'.repeat(index)}😀${'b'.repeat(rest)}`

test('responses: a lone surrogate never reaches the wire, and a whole pair is kept', () => {
  const raw: string[] = []
  const out: ResponseSink = {
    writableEnded: false,
    destroyed: false,
    write: (chunk: string) => raw.push(chunk) > 0,
    end: () => undefined,
    on: () => undefined,
  }
  const stream = new ResponsesStream(out, { model: 'opus' })
  stream.begin()
  stream.textDelta('cut \uD83D here, whole 😀')
  stream.codexToolCall({ callId: 'c1', name: 'exec', custom: false, args: { cmd: 'echo \uDE00' } })
  stream.complete(usageObject(), { endTurn: false })
  const wire = raw.join('')
  assert.ok(!LONE_ESCAPE.test(wire), 'no \\udXXX escape on the wire')
  assert.ok(isWellFormed(wire))
  const events = raw.map((chunk) => JSON.parse(chunk.split('\ndata: ')[1] ?? '{}'))
  const delta = events.find((e) => e.type === 'response.output_text.delta')
  assert.equal(delta?.delta, 'cut � here, whole 😀')
  const call = events.find((e) => e.type === 'response.output_item.done' && e.item.call_id)
  assert.equal(JSON.parse(call?.item.arguments).cmd, 'echo �')
})

test('tool display: a cut never splits a surrogate pair', () => {
  // "Ran `" is 5 characters, so the emoji's first half is character 149.
  const line = progressLine('Bash', { command: emojiAt(143, 50) }, null)
  assert.equal(line, `Ran \`${'a'.repeat(143)}…`)
  assert.ok(isWellFormed(line))
  const bash = describeToolUse(
    { name: 'Bash', input: { command: emojiAt(1499, 10), description: emojiAt(98, 10) } },
    null,
  )
  assert.ok(bash?.kind === 'reasoning' && isWellFormed(bash.text))
  assert.ok(isWellFormed(describeToolError('Read', emojiAt(218, 10))))
})

test('codex input: the context is cut without splitting a surrogate pair', () => {
  const head = parseCodexRequest({
    input: [
      { type: 'function_call', call_id: 'c', name: 'exec', arguments: emojiAt(599, 0) },
      user('go'),
    ],
  })
  assert.ok(head.context.includes('a'.repeat(599)))
  assert.ok(isWellFormed(head.context))
  // The last 60000 characters start with the emoji's second half.
  const tail = parseCodexRequest({
    input: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: emojiAt(10, 59999) }],
      },
      user('go'),
    ],
  })
  assert.ok(tail.context.endsWith('b'.repeat(59999)))
  assert.ok(isWellFormed(tail.context))
})

test('codex input: an item with a crafted type is dropped, never thrown on', () => {
  const crafted = { type: { toString: 1 }, id: 'msg_ae_1' }
  assert.deepEqual(sanitizeInputForOpenAI([crafted, user('x')]), {
    input: [user('x')],
    changed: true,
  })
  assert.equal(parseCodexRequest({ input: [user('a'), crafted, user('hi')] }).promptText, 'hi')
})

// The regexes the linear scans replaced, as oracles on the input Codex sends.
function regexEnvironment(text: string): string | null {
  const primary = text.match(/<environment[^>]*primary="true"[^>]*>[\s\S]*?<cwd>([\s\S]*?)<\/cwd>/)
  const cwd = (primary || text.match(/<cwd>([\s\S]*?)<\/cwd>/))?.[1]
  if (!cwd) return null
  return cwd
    .trim()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function regexDeveloper(text: string): { skills: string | null; planMode: boolean } {
  const collab = [...text.matchAll(/<collaboration_mode>([\s\S]*?)<\/collaboration_mode>/g)].at(-1)
  return {
    skills: text.match(/<skills_instructions>[\s\S]*?<\/skills_instructions>/)?.[0] ?? null,
    planMode: collab ? /#\s*Plan Mode|mode is plan/i.test(collab[1] ?? '') : false,
  }
}

test('codex input: the linear scans read what the regexes read', () => {
  const environments = [
    '<environment_context>\n  <cwd>/work/repo</cwd>\n  <approval_policy>on-request</approval_policy>\n  <sandbox_mode>workspace-write</sandbox_mode>\n  <shell>zsh</shell>\n</environment_context>',
    '<environment_context>\n<environments>\n<environment id="a"><cwd>/a</cwd></environment>\n<environment id="b" primary="true"><cwd>/b</cwd></environment>\n</environments>\n</environment_context>',
    '<environment_context><environment primary="false"><cwd>/no</cwd></environment><environment primary="true"><cwd>/yes</cwd></environment></environment_context>',
    '<environment_context><cwd>/first</cwd><environment primary="true"></environment></environment_context>',
    '<environment_context primary="true">\n<cwd> /p </cwd>\n</environment_context>',
    '<environment_context><cwd>/a &amp; b/&lt;x&gt; &quot;q&quot; &apos;s&apos;</cwd></environment_context>',
    '<environment_context><cwd>   </cwd></environment_context>',
    '<environment_context><shell>zsh</shell></environment_context>',
    'Earlier text.\n<environment_context><cwd>/in</cwd></environment_context>',
    '<environment_context><cwd>/unclosed',
  ]
  for (const text of environments)
    assert.equal(parseEnvironment(text), regexEnvironment(text), text)

  const developers = [
    '<skills_instructions>\n## Skills\n- review: /skills/review/SKILL.md\n</skills_instructions>',
    'no tags at all',
    '<collaboration_mode># Plan Mode\nPlan first.</collaboration_mode>',
    '<collaboration_mode># Plan Mode</collaboration_mode> later <collaboration_mode>default</collaboration_mode>',
    '<collaboration_mode>default</collaboration_mode><collaboration_mode>The mode is plan.</collaboration_mode>',
    '<collaboration_mode># Plan Mode</collaboration_mode><collaboration_mode>unclosed',
    '<skills_instructions>a</skills_instructions><skills_instructions>b</skills_instructions>',
  ]
  for (const text of developers) {
    const parsed = parseCodexRequest({ input: [message('developer', text), user('go')] })
    assert.deepEqual(
      { skills: parsed.skills, planMode: parsed.planMode },
      regexDeveloper(text),
      text,
    )
  }
})

test('codex input: the cwd comes from the <environment_context> block alone, and from its first 16 KB', () => {
  const block = (inside: string) => `<environment_context>${inside}</environment_context>`
  const shell = block('<shell>zsh</shell>')
  assert.equal(parseEnvironment(`<cwd>/before</cwd>\n${shell}`), null)
  assert.equal(parseEnvironment(`${shell}\n<cwd>/after</cwd>`), null)
  assert.equal(
    parseEnvironment(`<cwd>/before</cwd>${block('<cwd>/in</cwd>')}<cwd>/after</cwd>`),
    '/in',
  )
  assert.equal(
    parseEnvironment(
      `<environment primary="true"><cwd>/outside</cwd></environment>${block('<cwd>/in</cwd>')}`,
    ),
    '/in',
  )
  // The block's opening tag plus `pad` characters, then the cwd: read while
  // its closing tag ends at 16 KB exactly, ignored one character further.
  const at = (pad: number) => block(`${' '.repeat(pad)}<cwd>/far</cwd>`)
  const edge = 16 * 1024 - '<environment_context>'.length - '<cwd>/far</cwd>'.length
  assert.equal(parseEnvironment(at(edge)), '/far')
  assert.equal(parseEnvironment(at(edge + 1)), null)
  assert.equal(parseEnvironment(`${'x'.repeat(100)}${at(edge + 1)}`), null)
})

test('codex input: a 1 MB hostile request parses in well under a second', () => {
  const nested = `<environment_context>${`<environment${'primary="true"'.repeat(100)}`.repeat(200)}`
  const cwds = `<environment_context>${'<cwd>'.repeat(40000)}`
  const agents = `# AGENTS.md instructions for /x\n\n<environment_context>${'<environment primary="true"'.repeat(5000)}`
  const developer = `${'<skills_instructions>'.repeat(10000)}${'<collaboration_mode>'.repeat(10000)}`
  const input = [
    message('developer', developer),
    user(nested),
    user(cwds),
    user(agents),
    user('go'),
  ]
  const size = [developer, nested, cwds, agents].reduce((n, text) => n + text.length, 0)
  assert.ok(size > 1_000_000, `${size} characters`)
  const started = performance.now()
  const parsed = parseCodexRequest({ input })
  sanitizeInputForOpenAI(input)
  const elapsed = performance.now() - started
  assert.ok(elapsed < 1000, `parsed in ${Math.round(elapsed)} ms`)
  assert.equal(parsed.cwd, null)
  assert.equal(parsed.skills, null)
})
