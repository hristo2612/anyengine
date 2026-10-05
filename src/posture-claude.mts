// Claude Code as the child of a Codex parent (spec 5.6, enforcement): the
// effect each Claude tool has, the PreToolUse relay's verdict for one call,
// and the launch flags for a posture. Every verdict comes from `decide`
// (src/posture.mts); nothing here has its own idea of what is allowed.
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookPermissionDecision,
} from '@anthropic-ai/claude-agent-sdk'
import { sandboxExecAvailable } from './bridge-exec.mjs'
import { claudeEnvironment } from './claude-environment.mjs'
import { projectConfigChanged } from './claude-project-guard.mjs'
import {
  contextPosture,
  decide,
  type Effect,
  isUnrestricted,
  type Posture,
  type PostureContext,
  postureContext,
  postureSummary,
  sandboxedOutcome,
} from './posture.mjs'
import { withLocalReadRestrictions } from './requirements-reads.mjs'
import type { RuntimeTurnContext } from './types.mjs'

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Monitor'])
// No effect outside the conversation. Task/Agent sub-agents run under the
// same hooks, so each of their own calls comes back through the relay;
// WebSearch is a hosted search on both sides, bounded by neither sandbox
// (spec 5.5 G6). The 2.1.284 built-ins left out touch a file, the network, a
// process or another session: TaskStop, CronCreate/CronDelete (durable jobs
// are a file), SendMessage, SendUserMessage, PushNotification, RemoteTrigger,
// LSP, Workflow, EnterWorktree/ExitWorktree, Artifact.
const INERT_TOOLS = new Set([
  'Task',
  'Agent',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'WebSearch',
  'ToolSearch',
  'Skill',
  'SlashCommand',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'ScheduleWakeup',
  'CronList',
  'StructuredOutput',
])
const MCP_RESOURCE_TOOLS = new Set(['ListMcpResourcesTool', 'ReadMcpResourceTool'])
export const BRIDGE_EXEC_TOOL = 'mcp__anyengine__exec'
const BRIDGE_TOOL_PREFIX = 'mcp__anyengine__'

// The tools server.mts#requestApproval can draw an approval card for
// (COMMAND_TOOLS and FILE_CHANGE_TOOLS in server-helpers.mts). The app has no
// card for an mcpToolCall item, so asking about any other tool would leave the
// turn waiting on nothing: those are refused instead.
export const APPROVAL_CARD_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit'])

export type ClaudeToolEffect = Effect | 'sandboxed' | 'inert'
export type ClaudeVerdict = 'allow' | 'ask' | 'deny'

export function claudeToolEffect(
  toolName: string,
  input: Record<string, unknown>,
): ClaudeToolEffect {
  if (READ_TOOLS.has(toolName)) return { kind: 'read' }
  if (WRITE_TOOLS.has(toolName)) {
    const path = toolPath(input)
    return path ? { kind: 'write', path } : { kind: 'unbounded' }
  }
  if (SHELL_TOOLS.has(toolName)) return { kind: 'unbounded' }
  if (toolName === 'WebFetch') return { kind: 'net' }
  if (INERT_TOOLS.has(toolName)) return 'inert'
  if (toolName === BRIDGE_EXEC_TOOL) return 'sandboxed'
  // The other bridge tools start threads that inherit this posture.
  if (toolName.startsWith(BRIDGE_TOOL_PREFIX)) return 'inert'
  if (toolName.startsWith('mcp__') || MCP_RESOURCE_TOOLS.has(toolName)) return { kind: 'mcp' }
  // A tool this build does not know runs outside every sandbox until shown otherwise.
  return { kind: 'unbounded' }
}

export function decideClaudeTool(
  posture: Posture,
  toolName: string,
  input: Record<string, unknown>,
  where: string | PostureContext,
): ClaudeVerdict {
  const effect = claudeToolEffect(toolName, input)
  if (effect === 'inert') return 'allow'
  const ctx = typeof where === 'string' ? postureContext(where) : where
  const outcome = effect === 'sandboxed' ? sandboxedOutcome(posture) : decide(posture, effect, ctx)
  if (outcome === 'allow' || outcome === 'deny') return outcome
  // The relay has no reviewer of its own, so `review` is asked of the human
  // (tighter), and only where the app can draw the card.
  return APPROVAL_CARD_TOOLS.has(toolName) ? 'ask' : 'deny'
}

// The server's answer to any runtime's permission request (server.mts
// requestApproval), Grok's included: its shell arrives as Bash and runs in
// Grok's own process, outside every sandbox. A shell call is declined, never
// put on a card, unless nothing is bounded (shellMode 'bash'), as the relay
// does for Claude; everything else is decideClaudeTool's.
export function approvalVerdict(
  posture: Posture,
  toolName: string,
  input: Record<string, unknown>,
  where: string,
): ClaudeVerdict {
  const unbounded = shellMode(posture, sandboxExecAvailable()) === 'bash'
  if (SHELL_TOOLS.has(toolName) && !unbounded) return 'deny'
  return decideClaudeTool(posture, toolName, input, where)
}

export interface ClaudeLaunch {
  shell: ShellMode
  // `plan`, or null to leave the CLI's own mode alone: the relay decides every
  // tool call either way, and a PreToolUse deny beats any allow rule.
  permissionMode: 'plan' | null
  disallowedTools: string[]
  relayPosture: Posture
  // A parent that does not trust the project gets a child that does not
  // either: the workspace trust dialog is refused, not answered (spec 5.5 G8).
  trustWorkspace: boolean
  // `user` (with --strict-mcp-config) when the project's Claude config no
  // longer matches the thread's baseline and the posture is bounded or
  // untrusted: the child loads neither project settings nor project MCP
  // servers, and `notice` says so in the thread.
  settingSources: 'user' | null
  // The thread's visible line: that isolation, and why the shell is off.
  notice: string | null
}

export const PROJECT_CONFIG_NOTICE =
  'Project Claude settings changed during this session; this Claude child runs without them.'

export function toClaudeLaunch(
  posture: Posture,
  options: { sandboxExec: boolean; projectConfigChanged?: boolean },
): ClaudeLaunch {
  posture = withLocalReadRestrictions(posture)
  const exempt = isUnrestricted(posture) && posture.trust !== 'untrusted'
  const isolated = options.projectConfigChanged === true && !exempt
  const shell = shellMode(posture, options.sandboxExec)
  const shellNotice = shellOffNotice(posture, shell)
  const notices = [isolated ? PROJECT_CONFIG_NOTICE : null, shellNotice].filter(Boolean)
  return {
    shell,
    permissionMode: posture.plan ? 'plan' : null,
    disallowedTools: posture.readRestricted
      ? [...READ_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS, 'Skill', 'SlashCommand']
      : shell === 'bash'
        ? []
        : ['Bash', 'Monitor'],
    relayPosture: posture,
    trustWorkspace: posture.trust !== 'untrusted',
    settingSources: isolated ? 'user' : null,
    notice: notices.length > 0 ? notices.join(' ') : null,
  }
}

export type ShellMode = 'bash' | 'exec' | 'none'

export const SHELL_OFF_NO_SANDBOX =
  "Shell commands are off in this thread: this Mac's codex, which sandboxes them, is not running. Files can still be read and edited within the thread's folders."
export const SHELL_OFF_UNTRUSTED =
  'Shell commands are off in this thread: its approval mode asks before every command, and sandboxed commands have no approval card here.'

// Where a Claude child's shell runs (spec 5.6): in the parent's sandbox (the
// bridge `exec` tool, the real codex child's command/exec) whenever that
// sandbox exists and bounds something; as Claude's own Bash only where
// nothing is bounded (full access); nowhere otherwise. "Nowhere" is the
// fail-closed case: no codex child to sandbox a command, or an approval mode
// that asks before every command while exec has no approval card.
export function shellMode(posture: Posture, sandboxExec: boolean): ShellMode {
  if (posture.plan || posture.readRestricted) return 'none'
  if (posture.fileSystem.kind === 'full-access') return 'bash'
  if (posture.approval === 'untrusted') return 'none'
  return sandboxExec ? 'exec' : 'none'
}

// The thread's line when it has no shell at all (plan mode says so itself).
function shellOffNotice(posture: Posture, shell: ShellMode): string | null {
  if (posture.readRestricted)
    return 'File and shell tools are off: this parent restricts reads that this adapter cannot sandbox.'
  if (shell !== 'none' || posture.plan) return null
  return posture.approval === 'untrusted' ? SHELL_OFF_UNTRUSTED : SHELL_OFF_NO_SANDBOX
}

export const SHELL_THROUGH_EXEC =
  "Shell commands run through the anyengine `exec` tool in this thread, inside the thread's sandbox."
export const SHELL_OFF_PLAN = 'Shell commands are off in this thread while it plans.'

// Why a shell call is refused, from the shell mode alone: a thread whose
// project settings are also isolated gets the shell's reason, not that one.
export function shellRefusal(posture: Posture, sandboxExec: boolean): string {
  if (posture.plan) return SHELL_OFF_PLAN
  return shellOffNotice(posture, shellMode(posture, sandboxExec)) ?? SHELL_THROUGH_EXEC
}

function toolPath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

// The bridge's MCP server name (BRIDGE_SERVER_NAME in bridge-control.mts):
// where the `exec` tool lives. Without it no sandbox can take the shell, so
// a bounded posture has none (shellMode).
const BRIDGE_SERVER = 'anyengine'

// The launch for one turn: the thread's posture, whether a sandbox can take
// the shell (the real codex child is running and this engine has the bridge),
// and whether the project's Claude config still matches the thread's baseline.
export function claudeLaunchFor(context: RuntimeTurnContext): ClaudeLaunch {
  const posture = contextPosture(context)
  const changed = projectConfigChanged(posture, context.cwd)
  return toClaudeLaunch(posture, {
    sandboxExec: sandboxExecFor(context),
    projectConfigChanged: changed,
  })
}

function sandboxExecFor(context: RuntimeTurnContext): boolean {
  return hasBridgeServer(context.mcpServers) && sandboxExecAvailable()
}

// What binds at spawn (`--model`, `--permission-mode`, `--disallowedTools`,
// the workspace trust answered at startup, `--setting-sources`): a change
// means a cold respawn that resumes the same Claude session.
export function claudeSpawnKey(context: RuntimeTurnContext): string {
  const { permissionMode, disallowedTools, trustWorkspace, settingSources } =
    claudeLaunchFor(context)
  const bound = [permissionMode, disallowedTools, trustWorkspace, settingSources]
  return JSON.stringify([context.model ?? null, context.modelAuthored === true, ...bound])
}

// The PreToolUse relay's answer for one call (spec 5.3, E2). An operator's
// ANYENGINE_ALLOWED_TOOLS pre-approves a tool the posture would ask about; it
// never turns a refusal into a run.
export function relayDecision(
  context: RuntimeTurnContext,
  toolName: string,
  input: Record<string, unknown>,
): { verdict: ClaudeVerdict; reason: string } {
  const posture = contextPosture(context)
  // A tool the launch leaves out (a shell no sandbox bounds, Task 2) is
  // refused outright, whichever runtime asks: never an approval card.
  if (claudeLaunchFor(context).disallowedTools.includes(toolName)) {
    return { verdict: 'deny', reason: shellRefusal(posture, sandboxExecFor(context)) }
  }
  let verdict = decideClaudeTool(posture, toolName, input, context.cwd)
  if (verdict === 'ask' && context.allowedTools?.includes(toolName)) verdict = 'allow'
  if (verdict === 'deny') {
    return { verdict, reason: `blocked by this thread's sandbox (${postureSummary(posture)})` }
  }
  return { verdict, reason: verdict === 'allow' ? 'auto-approved by anyengine' : 'asks the app' }
}

export const UNTRUSTED_PROJECT_NOTICE =
  'The parent thread does not trust this project; this Claude child runs without its settings.'

// For Claude without a terminal (claude -p, the SDK runtime), once per turn:
// the notice when it launches with the user's settings alone, else null. It
// has no trust dialog to refuse, so an untrusted project's config stays out
// as a changed one does. The flags follow the notice, so they cannot disagree.
// (A shell that is off is not isolation: the relay's refusal says why.)
export function headlessIsolation(context: RuntimeTurnContext): string | null {
  const launch = claudeLaunchFor(context)
  if (launch.settingSources) return PROJECT_CONFIG_NOTICE
  return launch.trustWorkspace ? null : UNTRUSTED_PROJECT_NOTICE
}

// The SDK runtime's PreToolUse hook, the PTY relay's rule: a hook's deny or
// ask beats an allow rule in the settings. A call the posture refuses is
// denied; one it would ask about is asked, which the CLI (SDK 0.3.201) hands
// to canUseTool, and so to the app's card, even when an allow rule matches.
// ANYENGINE_ALLOWED_TOOLS turns an ask into an allow (relayDecision); an
// allow goes on to the CLI's own rules.
export function postureHooks(
  context: RuntimeTurnContext,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const raw = input.tool_input
    const toolInput = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const relay = relayDecision(context, input.tool_name, toolInput)
    if (relay.verdict === 'allow') return {}
    const permissionDecision: HookPermissionDecision = relay.verdict
    const reason = { permissionDecisionReason: relay.reason }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, ...reason } }
  }
  return { PreToolUse: [{ hooks: [hook] }] }
}

// The SDK runtime's posture options: the launch's disallowed tools (a shell
// no sandbox bounds leaves the session), which hold under an operator's
// ANYENGINE_PERMISSION_MODE override too, and the PreToolUse relay
// (postureHooks), which that override drops.
export function sdkPostureOptions(
  context: RuntimeTurnContext,
  withHooks: boolean,
): {
  env: Record<string, string>
  disallowedTools: string[]
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>
} {
  const { disallowedTools, shell } = claudeLaunchFor(context)
  const options = { env: claudeEnvironment(shell), disallowedTools }
  return withHooks ? { ...options, hooks: postureHooks(context) } : options
}

// The workspace trust dialog of a project the parent does not trust is
// refused, and the turn fails with this error, rather than answered.
export function trustRefusal(context: RuntimeTurnContext, dialogLabel: string): Error | null {
  if (!/trust this folder/i.test(dialogLabel)) return null
  if (claudeLaunchFor(context).trustWorkspace) return null
  return new Error(
    'the parent thread does not trust this project, so Claude is not started with the workspace trusted',
  )
}

function hasBridgeServer(mcpServers: unknown): boolean {
  if (!mcpServers || typeof mcpServers !== 'object') return false
  const record = mcpServers as Record<string, unknown>
  const servers =
    record.mcpServers && typeof record.mcpServers === 'object' ? record.mcpServers : record
  return BRIDGE_SERVER in (servers as object)
}
