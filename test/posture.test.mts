import assert from 'node:assert/strict'
import { readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { claimTurnContext } from '../src/claim-turn.mjs'
import {
  applyCodexParams,
  claimPosture,
  contextPosture,
  DEFAULT_POSTURE,
  fromClaudePermissionMode,
  isUnrestricted,
  legacyPosture,
  noLooser,
  type Outcome,
  outcomeRank,
  POSTURE_SCHEMA_COVERAGE,
  type Posture,
  type PostureContext,
  parseStoredPosture,
  postureContext,
  reach,
  realPath,
  sandboxedOutcome,
  toCodexExecSandboxPolicy,
  toCodexThreadStart,
  toCodexTurn,
} from '../src/posture.mjs'
import {
  APPROVAL_CARD_TOOLS,
  approvalVerdict,
  type ClaudeToolEffect,
  claudeToolEffect,
  decideClaudeTool,
  SHELL_OFF_NO_SANDBOX,
  SHELL_OFF_UNTRUSTED,
  shellMode,
  toClaudeLaunch,
} from '../src/posture-claude.mjs'
import { COMMAND_TOOLS, FILE_CHANGE_TOOLS } from '../src/server-helpers.mjs'
import { trampolineArgs } from '../src/trampoline-launch.mjs'
import {
  type ClaudeColumn,
  everyPosture,
  POSTURE_COUNT,
  postureTree,
  probes,
} from './helpers/postures.mjs'

const tree = postureTree()
const { ctx } = tree
const PROBES = probes(tree)
after(() => rmSync(tree.base, { recursive: true, force: true }))

const claudeModes = JSON.parse(
  readFileSync(resolve('test/fixtures/claude-permission-modes.json'), 'utf8'),
) as { modes: Record<string, Record<ClaudeColumn, Outcome>> }

function looser(child: Outcome, parent: Outcome): boolean {
  return outcomeRank(child) > outcomeRank(parent)
}

// What a Codex child is started with for a parent: thread/start, then the
// first turn/start carrying the full sandbox policy.
function codexChild(parent: Posture): Posture {
  const started = applyCodexParams(DEFAULT_POSTURE, toCodexThreadStart(parent))
  return applyCodexParams(started, toCodexTurn(parent))
}

function write(path: string): { kind: 'write'; path: string } {
  return { kind: 'write', path }
}

const WS = {
  kind: 'workspace-write' as const,
  writableRoots: [] as string[],
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
}

test('posture: requests, turns and lifecycle answers parse into one type', () => {
  // The app's local host sends a profile id and nothing else (26.911).
  const workspace = applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace', sandbox: null })
  assert.deepEqual(workspace.fileSystem, WS)
  assert.equal(workspace.approval, 'on-request')
  assert.equal(workspace.network, false)

  // turn/start keeps roots, network and the tmp exclusions (spec 5.6, fix 3).
  const turn = applyCodexParams(workspace, {
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/data'],
      networkAccess: true,
      excludeSlashTmp: true,
    },
  })
  assert.deepEqual(turn.fileSystem, { ...WS, writableRoots: ['/data'], excludeSlashTmp: true })
  assert.equal(turn.network, true)
  // A turn that names nothing keeps the thread's posture.
  assert.deepEqual(applyCodexParams(turn, { input: [] }), turn)

  // A granular policy survives as flags (fix 2); a flag left out reads false.
  const granular = applyCodexParams(DEFAULT_POSTURE, {
    approvalPolicy: { granular: { sandbox_approval: false, rules: true, mcp_elicitations: true } },
  })
  assert.deepEqual(granular.approval, {
    granular: {
      sandbox_approval: false,
      rules: true,
      mcp_elicitations: true,
      skill_approval: false,
      request_permissions: false,
    },
  })

  // externalSandbox stays external; it used to become workspace-write.
  const external = applyCodexParams(DEFAULT_POSTURE, {
    sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' },
  })
  assert.equal(external.fileSystem.kind, 'external')
  assert.equal(external.network, true)

  // Aliases: on-failure is on-request (fix 6), guardian_subagent is auto_review.
  assert.equal(
    applyCodexParams(DEFAULT_POSTURE, { approvalPolicy: 'on-failure' }).approval,
    'on-request',
  )
  assert.equal(
    applyCodexParams(DEFAULT_POSTURE, { approvalsReviewer: 'guardian_subagent' }).reviewer,
    'auto_review',
  )
  assert.equal(
    applyCodexParams(DEFAULT_POSTURE, { collaborationMode: { mode: 'plan', settings: {} } }).plan,
    true,
  )

  // The real child's thread/start answer carries the effective SandboxPolicy.
  const answer = applyCodexParams(DEFAULT_POSTURE, {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: { type: 'workspaceWrite', writableRoots: ['/w'], networkAccess: true },
    activePermissionProfile: { id: ':workspace', extends: null },
  })
  assert.deepEqual(answer.fileSystem, { ...WS, writableRoots: ['/w'] })
  assert.equal(answer.network, true)
  assert.equal(answer.reviewer, 'auto_review')

  // A named profile beside sandbox fields in the same request: Codex refuses
  // the combination, and the looser reading never wins.
  const both = applyCodexParams(DEFAULT_POSTURE, {
    permissions: ':workspace',
    sandboxPolicy: { type: 'dangerFullAccess' },
  })
  assert.equal(both.fileSystem.kind, 'workspace-write')
})

test('posture: nothing, junk or a custom profile is the tight default, never full access', () => {
  assert.deepEqual(applyCodexParams(DEFAULT_POSTURE, {}), DEFAULT_POSTURE)
  assert.equal(DEFAULT_POSTURE.fileSystem.kind, 'read-only')
  assert.equal(DEFAULT_POSTURE.approval, 'on-request')
  // A custom profile's contents are invisible here (fix 7).
  const custom = applyCodexParams(DEFAULT_POSTURE, { permissions: 'team-profile' })
  assert.equal(custom.fileSystem.kind, 'read-only')
  assert.equal(custom.approval, 'on-request')
  // A value this build cannot read tightens; it never keeps a looser base.
  const full = applyCodexParams(DEFAULT_POSTURE, { permissions: ':danger-full-access' })
  assert.equal(isUnrestricted(full), true)
  assert.equal(applyCodexParams(full, { sandbox: 'future-mode' }).fileSystem.kind, 'read-only')
  assert.equal(
    applyCodexParams(full, { sandboxPolicy: { type: 'futureSandbox' } }).fileSystem.kind,
    'read-only',
  )
  // Rows stored before M0 convert as recorded.
  assert.equal(isUnrestricted(legacyPosture('never', 'danger-full-access')), true)
  assert.deepEqual(legacyPosture(null, null), DEFAULT_POSTURE)
})

// The app updates itself between runs of CI's schema gate, so a collaboration
// mode this build does not know can arrive at runtime. Like an unknown sandbox
// or approval it reads as the tightest: plan, which a Claude child launches in.
test('posture: an unknown collaboration mode is plan, and is reported once', () => {
  const lines: string[] = []
  const write = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    const loose = { ...DEFAULT_POSTURE, plan: false }
    const pair = applyCodexParams(loose, { collaborationMode: { mode: 'pair-v2', settings: {} } })
    assert.equal(pair.plan, true)
    assert.equal(toClaudeLaunch(pair, { sandboxExec: false }).permissionMode, 'plan')
    // Twice more, the same value: still plan, no second report.
    assert.equal(applyCodexParams(loose, { collaborationMode: { mode: 'pair-v2' } }).plan, true)
    assert.equal(applyCodexParams(pair, { collaborationMode: { mode: 'pair-v2' } }).plan, true)
    // A mode missing from the object, or not a string: also plan.
    assert.equal(applyCodexParams(loose, { collaborationMode: { settings: {} } }).plan, true)
    assert.equal(applyCodexParams(loose, { collaborationMode: 'default' }).plan, true)
    assert.equal(lines.filter((line) => line.includes('"pair-v2"')).length, 1, lines.join(''))
    assert.match(lines.join(''), /unknown collaboration mode "pair-v2": read as plan/)
    // What the app sends today reads as before, and naming no mode keeps the base.
    const planned = { ...DEFAULT_POSTURE, plan: true }
    assert.equal(applyCodexParams(planned, { collaborationMode: { mode: 'default' } }).plan, false)
    assert.equal(applyCodexParams(loose, { collaborationMode: { mode: 'plan' } }).plan, true)
    assert.equal(applyCodexParams(planned, { collaborationMode: null }).plan, true)
    assert.equal(applyCodexParams(loose, {}).plan, false)
  } finally {
    process.stderr.write = write
  }
})

test('posture: a sandbox named twice or unreadably takes the tighter reading', () => {
  const full = applyCodexParams(DEFAULT_POSTURE, { permissions: ':danger-full-access' })
  const cases: Array<[Record<string, unknown>, Posture['fileSystem']['kind'], boolean]> = [
    // A profile beside sandbox fields: neither side loosens the other.
    [
      { permissions: ':danger-full-access', sandboxPolicy: { type: 'readOnly' } },
      'read-only',
      false,
    ],
    [{ permissions: ':danger-full-access', sandbox: 'workspace-write' }, 'workspace-write', false],
    [{ permissions: 'team-profile', sandbox: 'danger-full-access' }, 'read-only', false],
    // The mode string beside the policy struct, in either order.
    [{ sandbox: 'read-only', sandboxPolicy: { type: 'dangerFullAccess' } }, 'read-only', false],
    [{ sandbox: 'danger-full-access', sandboxPolicy: { type: 'readOnly' } }, 'read-only', false],
    // Values this build cannot read never keep a looser base.
    [{ sandbox: { type: 'futureSandbox' } }, 'read-only', false],
    [{ sandbox: 42 }, 'read-only', false],
    [{ permissions: 'x'.repeat(129) }, 'read-only', false],
    [{ permissions: { id: 'team' } }, 'read-only', false],
    [{ permissions: null }, 'full-access', true],
    [{ sandboxPolicy: { type: 'externalSandbox', networkAccess: 'maybe' } }, 'external', false],
  ]
  for (const [params, kind, network] of cases) {
    const got = applyCodexParams(full, params)
    assert.deepEqual([got.fileSystem.kind, got.network], [kind, network], JSON.stringify(params))
  }
  // Two workspace readings keep only what both allow; an external sandbox
  // beside one bounds writes to the cwd.
  const ws = applyCodexParams(full, {
    sandbox: { type: 'workspaceWrite', writableRoots: ['/a', '/b'], networkAccess: true },
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/b', '/c'], excludeSlashTmp: true },
  })
  assert.deepEqual(ws.fileSystem, { ...WS, writableRoots: ['/b'], excludeSlashTmp: true })
  assert.equal(ws.network, false)
  const mixed = applyCodexParams(full, {
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' },
  })
  assert.deepEqual(mixed.fileSystem, { ...WS, excludeTmpdirEnvVar: true, excludeSlashTmp: true })
  const auto = applyCodexParams(DEFAULT_POSTURE, { approvalsReviewer: 'auto_review' })
  assert.equal(applyCodexParams(auto, { approvalsReviewer: 'future_reviewer' }).reviewer, 'user')
  assert.equal(applyCodexParams(auto, { approvalsReviewer: null }).reviewer, 'auto_review')
  // An approval this build cannot read asks before everything, even beside a
  // profile whose default is `never`; an absent one keeps the base.
  for (const [base, params] of [
    [full, { approvalPolicy: 'always-ask' }],
    [legacyPosture('never', 'danger-full-access'), { approvalPolicy: 'always-ask' }],
    [DEFAULT_POSTURE, { permissions: ':danger-full-access', approvalPolicy: 'always-ask' }],
  ] as const) {
    const got = applyCodexParams(base, params)
    assert.ok(got.approval === 'untrusted' && !isUnrestricted(got), JSON.stringify(params))
  }
  assert.equal(applyCodexParams(full, { approvalPolicy: null }).approval, 'never')
  assert.equal(isUnrestricted(legacyPosture('always-ask', 'danger-full-access')), false)
})

test('posture: `never` means no prompts, not no bounds', () => {
  const never: Posture = {
    ...DEFAULT_POSTURE,
    fileSystem: { ...WS, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    approval: 'never',
  }
  assert.equal(reach(never, { kind: 'write', path: join(ctx.cwd, 'a.txt') }, ctx), 'allow')
  assert.equal(reach(never, { kind: 'write', path: join(tree.outside, 'a.txt') }, ctx), 'deny')
  assert.equal(reach(never, { kind: 'unbounded' }, ctx), 'deny')
  assert.equal(reach(never, { kind: 'net' }, ctx), 'deny')
  const readOnly = { ...never, fileSystem: { kind: 'read-only' } } as Posture
  assert.equal(reach(readOnly, { kind: 'write', path: join(ctx.cwd, 'a.txt') }, ctx), 'deny')
  assert.equal(isUnrestricted(never), false)
})

test('posture: a write is judged by where it lands, not how its path is spelled', () => {
  const noTmp: Posture = {
    ...DEFAULT_POSTURE,
    fileSystem: { ...WS, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    approval: 'never',
  }
  const withTmp: Posture = { ...noTmp, fileSystem: { ...WS, excludeTmpdirEnvVar: true } }
  // Relative paths resolve against the cwd, `..` included. A link out of the
  // workspace counts where it points, a dangling one where its target would be
  // created, a loop nowhere; a protected name matches in any case (macOS).
  assert.equal(reach(noTmp, write('sub/b.txt'), ctx), 'allow')
  const escapes = ['../outside/h.txt', 'sub/../../outside/h', 'escape/c.txt', 'escape/new/d']
  for (const path of [...escapes, 'dangle', 'dangdir/x.txt', 'loop-a/x', '.GIT/config']) {
    assert.equal(reach(noTmp, write(path), ctx), 'deny', path)
  }
  assert.equal(decideClaudeTool(noTmp, 'Write', { file_path: '../outside/h.txt' }, ctx), 'deny')
  const ask = { ...noTmp, approval: 'on-request' } as const
  for (const file_path of ['dangle', join(ctx.cwd, 'dangdir', 'x.txt'), '.GIT/config']) {
    assert.equal(decideClaudeTool(ask, 'Edit', { file_path }, ctx), 'ask', file_path)
  }
  // A temp root that is a link (macOS /tmp is one, to /private/tmp): the link
  // and its target are one place, allowed together and excluded together.
  const link = join(tree.base, 'tmp-link')
  symlinkSync(ctx.slashTmp, link)
  const cases: Array<[PostureContext, string[]]> = [
    [{ ...ctx, slashTmp: link }, [join(link, 'x.txt'), join(ctx.slashTmp, 'x.txt')]],
  ]
  // The real /tmp on macOS: paths are resolved and compared, nothing is written.
  if (process.platform === 'darwin') {
    cases.push([postureContext(ctx.cwd), ['/tmp/ae-probe/x', '/private/tmp/ae-probe/x']])
  }
  for (const [where, paths] of cases) {
    for (const path of paths) {
      assert.equal(reach(withTmp, write(path), where), 'allow', path)
      assert.equal(reach(noTmp, write(path), where), 'deny', path)
    }
  }
  assert.throws(() => realPath(join(ctx.cwd, 'loop-a', 'x')), { code: 'ELOOP' }) // never a string
})

test('never looser: Codex parent to Codex child, over every posture', () => {
  let count = 0
  for (const parent of everyPosture(tree)) {
    const child = codexChild(parent)
    for (const probe of PROBES) {
      const got = reach(child, probe.effect, ctx)
      const bound = reach(parent, probe.effect, ctx)
      assert.ok(!looser(got, bound), `${JSON.stringify(parent)} ${probe.label}: ${got} > ${bound}`)
    }
    count += 1
  }
  assert.equal(count, POSTURE_COUNT)
})

test('never looser: a command run through exec reaches no more than its parent', () => {
  for (const parent of everyPosture(tree)) {
    // The exec sandbox as a posture that never escalates: `allow` is inside it.
    const policy = toCodexExecSandboxPolicy(parent, ctx.cwd)
    const sandbox: Posture = {
      ...applyCodexParams(DEFAULT_POSTURE, { sandboxPolicy: policy }),
      approval: 'never',
    }
    for (const probe of PROBES) {
      if (probe.effect.kind === 'mcp' || reach(sandbox, probe.effect, ctx) !== 'allow') continue
      const got = sandboxedOutcome(parent)
      const bound = reach(parent, probe.effect, ctx)
      assert.ok(!looser(got, bound), `${JSON.stringify(parent)} ${probe.label}: ${got} > ${bound}`)
    }
  }
})

const CLAUDE_TOOLS: Array<{
  tool: string
  input: Record<string, unknown>
  effect: ClaudeToolEffect
}> = [
  { tool: 'Read', input: { file_path: join(tree.outside, 'x') }, effect: { kind: 'read' } },
  {
    tool: 'Write',
    input: { file_path: join(ctx.cwd, 'a.txt') },
    effect: { kind: 'write', path: join(ctx.cwd, 'a.txt') },
  },
  {
    tool: 'Write',
    input: { file_path: 'rel/b.txt' },
    effect: { kind: 'write', path: 'rel/b.txt' },
  },
  {
    tool: 'Edit',
    input: { file_path: join(ctx.cwd, '.git', 'config') },
    effect: { kind: 'write', path: join(ctx.cwd, '.git', 'config') },
  },
  {
    tool: 'MultiEdit',
    input: { file_path: join(ctx.cwd, 'escape', 'c.txt') },
    effect: { kind: 'write', path: join(ctx.cwd, 'escape', 'c.txt') },
  },
  {
    tool: 'NotebookEdit',
    input: { notebook_path: join(tree.extra, 'n.ipynb') },
    effect: { kind: 'write', path: join(tree.extra, 'n.ipynb') },
  },
  {
    tool: 'Write',
    input: { file_path: join(tree.outside, 'g.txt') },
    effect: { kind: 'write', path: join(tree.outside, 'g.txt') },
  },
  { tool: 'Write', input: {}, effect: { kind: 'unbounded' } },
  { tool: 'Bash', input: { command: 'ls' }, effect: { kind: 'unbounded' } },
  { tool: 'Monitor', input: {}, effect: { kind: 'unbounded' } },
  { tool: 'WebFetch', input: { url: 'https://example.com' }, effect: { kind: 'net' } },
  { tool: 'mcp__github__create_issue', input: {}, effect: { kind: 'mcp' } },
  { tool: 'mcp__anyengine__exec', input: { command: 'ls' }, effect: 'sandboxed' },
  { tool: 'mcp__anyengine__spawn_subagents', input: {}, effect: 'inert' },
  { tool: 'Task', input: {}, effect: 'inert' },
  { tool: 'WebSearch', input: {}, effect: 'inert' },
  { tool: 'ToolSearch', input: {}, effect: 'inert' },
  { tool: 'SomeFutureTool', input: {}, effect: { kind: 'unbounded' } },
]

test('posture: Claude tools map to the effects they have', () => {
  for (const { tool, input, effect } of CLAUDE_TOOLS) {
    assert.deepEqual(claudeToolEffect(tool, input), effect, tool)
  }
})

test('never looser: Codex parent to Claude child (launch and relay), over every posture', () => {
  const parents = Array.from(everyPosture(tree)).flatMap((parent) => [
    parent,
    { ...parent, readRestricted: true },
  ])
  for (const parent of parents) {
    for (const sandboxExec of [false, true]) {
      const launch = toClaudeLaunch(parent, { sandboxExec })
      assert.equal(launch.relayPosture, parent)
      assert.equal(launch.permissionMode, parent.plan ? 'plan' : null)
      // Nothing runs a shell outside a sandbox unless nothing is bounded (spec 5.6).
      if (parent.fileSystem.kind !== 'full-access')
        assert.ok(launch.disallowedTools.includes('Bash'), `${JSON.stringify(parent)} keeps Bash`)
      for (const { tool, input, effect } of CLAUDE_TOOLS) {
        const got: Outcome = launch.disallowedTools.includes(tool)
          ? 'deny'
          : decideClaudeTool(launch.relayPosture, tool, input, ctx)
        const bound: Outcome =
          // The read bound is independent of decide/reach, so a read-allow mutation cannot
          // turn both sides green. Read-restricted parents have no file/shell reach.
          parent.readRestricted &&
          effect !== 'inert' &&
          (effect === 'sandboxed' || effect.kind !== 'mcp')
            ? 'deny'
            : effect === 'inert'
              ? 'allow'
              : effect === 'sandboxed'
                ? sandboxedOutcome(parent)
                : reach(parent, effect, ctx)
        assert.ok(!looser(got, bound), `${JSON.stringify(parent)} ${tool}: ${got} > ${bound}`)
      }
    }
  }
})

test('never looser: Claude parent mode to Codex child', () => {
  for (const [mode, table] of Object.entries(claudeModes.modes)) {
    for (const strict of [false, true]) {
      const parent = fromClaudePermissionMode(mode, { strict })
      assert.ok(parent, mode)
      const child = codexChild(parent)
      for (const probe of PROBES) {
        // A Codex child runs its MCP tools without asking while Claude asks in
        // most modes, and Codex has no thread-level switch for that: recorded
        // for M2's Claude host, left out here.
        if (probe.claude === null) continue
        const got = reach(child, probe.effect, ctx)
        const bound = table[probe.claude]
        assert.ok(
          !looser(got, bound),
          `${mode}${strict ? ' strict' : ''} ${probe.label}: ${got} > ${bound}`,
        )
      }
    }
  }
})

test("never looser: only an unrestricted posture may drop a runtime's own approvals", () => {
  let unrestricted = 0
  for (const posture of everyPosture(tree)) {
    if (!isUnrestricted(posture)) continue
    unrestricted += 1
    for (const probe of PROBES)
      assert.equal(reach(posture, probe.effect, ctx), 'allow', probe.label)
  }
  assert.ok(unrestricted > 0)
})

test('posture: shell is exec inside a sandbox, Bash only where nothing is bounded, else none', () => {
  const ws = applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace' })
  const full = applyCodexParams(DEFAULT_POSTURE, { permissions: ':danger-full-access' })
  const ro = DEFAULT_POSTURE
  assert.equal(shellMode(ws, true), 'exec')
  assert.equal(shellMode(ws, false), 'none')
  assert.equal(shellMode(ro, false), 'none')
  assert.equal(shellMode(full, false), 'bash')
  assert.equal(shellMode(full, true), 'bash')
  assert.equal(shellMode({ ...ws, approval: 'untrusted' }, true), 'none')
  assert.equal(shellMode({ ...ws, plan: true }, true), 'none')
  assert.deepEqual(toClaudeLaunch(ws, { sandboxExec: true }).disallowedTools, ['Bash', 'Monitor'])
  assert.deepEqual(toClaudeLaunch(ws, { sandboxExec: false }).disallowedTools, ['Bash', 'Monitor'])
  assert.deepEqual(toClaudeLaunch(full, { sandboxExec: false }).disallowedTools, [])
  assert.equal(toClaudeLaunch(ws, { sandboxExec: false }).notice, SHELL_OFF_NO_SANDBOX)
  assert.equal(
    toClaudeLaunch({ ...ws, approval: 'untrusted' }, { sandboxExec: true }).notice,
    SHELL_OFF_UNTRUSTED,
  )
  assert.equal(toClaudeLaunch(ws, { sandboxExec: true }).notice, null)
})

// Every runtime's permission request goes through the server's gate (Grok's
// shell arrives as Bash and runs in Grok's own process): a shell no sandbox
// bounds is declined there, never put on a card.
test('never looser: no runtime gets a card for a shell outside full access', () => {
  for (const posture of everyPosture(tree)) {
    const own = posture.fileSystem.kind === 'full-access' && !posture.plan
    for (const tool of ['Bash', 'BashOutput', 'KillShell', 'Monitor']) {
      const verdict = approvalVerdict(posture, tool, { command: 'ls' }, ctx.cwd)
      if (!own) assert.equal(verdict, 'deny', `${JSON.stringify(posture)} ${tool}`)
      else assert.equal(verdict, decideClaudeTool(posture, tool, { command: 'ls' }, ctx.cwd))
    }
  }
})

test('posture: the relay asks only about tools the app draws a card for', () => {
  assert.deepEqual([...APPROVAL_CARD_TOOLS].sort(), [...COMMAND_TOOLS, ...FILE_CHANGE_TOOLS].sort())
  const ws = applyCodexParams(DEFAULT_POSTURE, { permissions: ':workspace' })
  assert.equal(decideClaudeTool(ws, 'Bash', { command: 'ls' }, ctx), 'ask')
  assert.equal(decideClaudeTool(ws, 'WebFetch', { url: 'https://example.com' }, ctx), 'deny')
  assert.equal(decideClaudeTool(ws, 'Write', { file_path: 'x.txt' }, ctx), 'allow')
  assert.equal(decideClaudeTool(ws, 'mcp__github__search', {}, ctx), 'allow')
})

test('posture: every Claude permission mode in the docs fixture converts', () => {
  for (const mode of Object.keys(claudeModes.modes)) {
    assert.ok(fromClaudePermissionMode(mode), mode)
    assert.equal(POSTURE_SCHEMA_COVERAGE.claudePermissionMode(mode), true, mode)
  }
  assert.equal(fromClaudePermissionMode('auto')?.reviewer, 'auto_review')
  assert.equal(fromClaudePermissionMode('auto', { strict: true })?.reviewer, 'user')
  assert.equal(fromClaudePermissionMode('no-such-mode'), null)
})

test('posture: a parent that does not trust the project gets a child that does not either', () => {
  const untrusted = applyCodexParams(DEFAULT_POSTURE, { approvalPolicy: 'untrusted' })
  assert.equal(untrusted.trust, 'untrusted')
  assert.equal(toClaudeLaunch(untrusted, { sandboxExec: false }).trustWorkspace, false)
  assert.equal(toClaudeLaunch(DEFAULT_POSTURE, { sandboxExec: false }).trustWorkspace, true)
  // Sticky: a later approval change does not re-trust the project.
  assert.equal(applyCodexParams(untrusted, { approvalPolicy: 'on-request' }).trust, 'untrusted')
})

test('posture: stored JSON round-trips and junk reads as null', () => {
  const stored = applyCodexParams(DEFAULT_POSTURE, {
    approvalPolicy: { granular: { sandbox_approval: true, rules: false, mcp_elicitations: true } },
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/data'], networkAccess: true },
  })
  assert.deepEqual(parseStoredPosture(JSON.stringify(stored)), stored)
  assert.equal(parseStoredPosture('{"fileSystem":{"kind":"root"}}'), null)
  // A known kind with its fields missing is junk too, not a half posture.
  const partial = { ...stored, fileSystem: { kind: 'workspace-write' } }
  assert.equal(parseStoredPosture(JSON.stringify(partial)), null)
  assert.equal(parseStoredPosture(JSON.stringify({ ...stored, plan: 'yes' })), null)
  for (const text of ['null', 'not json', null]) assert.equal(parseStoredPosture(text), null)
})

test('posture: command/exec gets the thread cwd as an explicit root', () => {
  const ws = applyCodexParams(DEFAULT_POSTURE, {
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/data'] },
  })
  assert.deepEqual(toCodexExecSandboxPolicy(ws, '/work'), {
    type: 'workspaceWrite',
    writableRoots: ['/work', '/data'],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  })
  const external = applyCodexParams(DEFAULT_POSTURE, { sandboxPolicy: { type: 'externalSandbox' } })
  assert.equal(toCodexExecSandboxPolicy(external, '/work').type, 'workspaceWrite')
  // Only the cwd, which is all an external sandbox's posture lets a write reach.
  assert.deepEqual(toCodexExecSandboxPolicy(external, '/work'), {
    type: 'workspaceWrite',
    writableRoots: ['/work'],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  })
  assert.deepEqual(toCodexExecSandboxPolicy({ ...ws, plan: true }, '/work'), {
    type: 'readOnly',
    networkAccess: false,
  })
})

test('never looser: a claimed child posture is no looser than the child or its parent, over every posture', () => {
  const outcomes = new Map<Posture, Outcome[]>()
  const vector = (p: Posture) => {
    if (!outcomes.has(p))
      outcomes.set(p, [...PROBES.map((probe) => reach(p, probe.effect, ctx)), sandboxedOutcome(p)])
    return outcomes.get(p)!
  }
  const variants = (p: Posture): Posture[] => [p, { ...p, readRestricted: true }]
  const children = [...everyPosture(tree)].filter((_, i) => i % 97 === 0).flatMap(variants)
  for (const parent of [...everyPosture(tree)].flatMap(variants)) {
    for (const child of children) {
      const got = claimPosture(child, parent, ctx)
      if (parent.readRestricted || child.readRestricted) {
        assert.equal(reach(got, { kind: 'read' }, ctx), 'deny', 'restricted read bound')
      }
      const bounds = [vector(parent), vector(child)]
      for (const [i, gotOutcome] of vector(got).entries()) {
        for (const bound of bounds)
          assert.ok(!looser(gotOutcome, bound[i]!), `${i}: looser than child or parent`)
      }
    }
  }
  for (const probe of probes(tree)) {
    for (const any of [...everyPosture(tree)].filter((_, i) => i % 53 === 0).flatMap(variants)) {
      assert.ok(
        !looser(
          reach(claimPosture(null, null, ctx), probe.effect, ctx),
          reach(any, probe.effect, ctx),
        ),
        'the strictest is no looser than anything',
      )
    }
  }
})

test('claim posture: extra writable roots and protected boundaries are compared', () => {
  const base: Posture = {
    ...DEFAULT_POSTURE,
    approval: 'never',
    fileSystem: { ...WS, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
  }
  const extra: Posture = {
    ...base,
    fileSystem: {
      ...WS,
      writableRoots: [tree.extra],
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  }
  assert.equal(noLooser(extra, base, ctx), false)
  assert.equal(noLooser(base, extra, ctx), true)
  assert.equal(claimPosture(extra, base, ctx), base)
  // A nested root can re-enable the ancestor's protected .git subtree.
  const protectedRoot: Posture = {
    ...base,
    fileSystem: {
      ...WS,
      writableRoots: [join(ctx.cwd, '.git')],
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  }
  assert.equal(noLooser(protectedRoot, base, ctx), false)
})

// Finite 3,080-posture cross product; test the actual argv, not just a constant.
test('never looser: a model-mode trampoline child over every posture and tool, known or not', () => {
  let checked = 0
  let offeredChecks = 0
  for (const parent of everyPosture(tree)) {
    const args = trampolineArgs({
      claudeModel: 'opus',
      effort: null,
      planMode: parent.plan,
      resume: null,
      fork: false,
      mcpConfig: { mcpServers: { codex: {} } },
      systemPrompt: '',
      codexToolsOffered: true,
      caps: {
        ok: true,
        partial: true,
        effort: true,
        permissionPrompts: true,
        tools: true,
        restricted: true,
        disableSlashCommands: true,
      },
    })
    const flag = (name: string) => {
      assert.ok(args.includes(name), name)
      const value = args[args.indexOf(name) + 1]
      assert.ok(value !== undefined, name)
      return value
    }
    const offered = new Set(flag('--tools').split(',').filter(Boolean))
    const denied = new Set(flag('--disallowedTools').split(','))
    for (const read of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
      assert.ok(!offered.has(read), read)
    assert.ok(args.includes('--disable-slash-commands'))
    assert.ok(args.includes('--restricted'))
    assert.equal(
      offered.has('ToolSearch'),
      !parent.plan,
      'tool discovery is available only outside plan mode',
    )
    if (parent.plan) assert.equal(offered.size, 0)
    assert.ok(!args.includes('--dangerously-skip-permissions'))
    assert.equal(flag('--permission-mode'), parent.plan ? 'plan' : 'default')
    assert.equal(flag('--setting-sources'), 'user')
    assert.deepEqual(JSON.parse(flag('--settings')), {
      disableAllHooks: true,
      disableSkillShellExecution: true,
    })
    assert.ok(args.includes('--strict-mcp-config'))
    assert.deepEqual(
      Object.keys(JSON.parse(flag('--mcp-config')).mcpServers),
      parent.plan ? [] : ['codex'],
    )
    // Agent/Task are inert in the relay model only because their children use
    // hooks. The trampoline has no hooks, so delegation must stay excluded.
    for (const name of [
      'Task',
      'Agent',
      'Skill',
      'SlashCommand',
      'ScheduleWakeup',
      'AskUserQuestion',
    ]) {
      assert.ok(!offered.has(name), name)
      assert.ok(denied.has(name), name)
    }
    for (const tool of offered) {
      const effect = claudeToolEffect(tool, {})
      assert.ok(effect === 'inert', tool)
      assert.ok(!denied.has(tool), tool)
      offeredChecks++
    }
    for (const { tool, input, effect } of CLAUDE_TOOLS) {
      if (tool.startsWith('mcp__') || !offered.has(tool) || denied.has(tool)) continue
      assert.ok(effect === 'inert', tool)
      assert.equal(claudeToolEffect(tool, input), 'inert')
    }
    assert.equal(offered.has('SomeFutureTool'), false)
    checked++
  }
  assert.equal(checked, POSTURE_COUNT)
  // Half the enumerated postures are plan mode, which offers no tools.
  assert.equal(offeredChecks, POSTURE_COUNT / 2)
})

test('never looser: a claimed Claude child (native spawn) under a Codex parent, over every posture', () => {
  for (const parent of everyPosture(tree)) {
    const context = claimTurnContext({
      thread: {
        threadId: 't',
        parentThreadId: 'p',
        parentCwd: ctx.cwd,
        cwd: ctx.cwd,
        model: 'opus',
        posture: parent,
      },
      request: {
        op: 'claim',
        threadId: 't',
        parentThreadId: 'p',
        turnId: 'u',
        model: 'opus',
        prompt: 'x',
        cwd: null,
        effort: null,
      },
      sessionId: null,
      mcpServers: null,
    })
    assert.deepEqual(contextPosture(context), parent)
    assert.equal(context.allowedTools, null)
    for (const sandboxExec of [false, true]) {
      const launch = toClaudeLaunch(contextPosture(context), { sandboxExec })
      for (const { tool, input, effect } of CLAUDE_TOOLS) {
        let got: Outcome = launch.disallowedTools.includes(tool)
          ? 'deny'
          : decideClaudeTool(launch.relayPosture, tool, input, ctx)
        // A claimed child has no approval card (decision D3): an ask is refused.
        if (got === 'ask') got = 'deny'
        const bound: Outcome =
          effect === 'inert'
            ? 'allow'
            : effect === 'sandboxed'
              ? sandboxedOutcome(parent)
              : reach(parent, effect, ctx)
        assert.ok(!looser(got, bound), `${JSON.stringify(parent)} ${tool}: ${got} > ${bound}`)
      }
    }
  }
})
