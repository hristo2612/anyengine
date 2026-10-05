// Claimed native children use their effective claim posture, never a request's
// claimed parent identity or pre-approved tools. Approval asks are refused.
import { BRIDGE_LINE } from './bridge-instructions.mjs'
import type { ClaimEvent, ClaimRequest } from './claim-protocol.mjs'
import type { ClaimThread } from './claim-types.mjs'
import { modelPrompt } from './model-prompt.mjs'
import { childStart, postureFields } from './posture.mjs'
import { progressLine } from './tool-display.mjs'
import type { RuntimeEvent, RuntimeTurnContext } from './types.mjs'
import { resolveClaudeEffort, resolveClaudeModel } from './util.mjs'

export function claimTurnContext(input: {
  thread: ClaimThread
  request: ClaimRequest
  sessionId: string | null
  mcpServers: unknown
}): RuntimeTurnContext {
  const { thread, request } = input
  const root = thread.parentCwd ?? thread.cwd
  const start = childStart(
    { posture: thread.posture, cwd: root },
    request.cwd ?? thread.cwd ?? undefined,
  )
  return {
    modelAuthored: true,
    threadId: thread.threadId,
    turnId: request.turnId ?? `claim-${Date.now()}`,
    purpose: 'normal',
    prompt: modelPrompt(request.prompt),
    cwd: start.cwd,
    runtimeType: null,
    model: resolveClaudeModel(request.model),
    effort: resolveClaudeEffort(request.effort),
    claudeSessionId: input.sessionId,
    forkSession: false,
    mcpServers: input.mcpServers,
    allowedTools: null,
    addDirs: [],
    enableFileCheckpointing: false,
    outputFormat: null,
    ...postureFields(start.posture),
    systemPromptAddendum: BRIDGE_LINE,
    planMode: start.posture.plan,
    imageInputs: [],
  }
}

export function claimEventsFor(event: RuntimeEvent, cwd: string | null): ClaimEvent[] {
  switch (event.type) {
    case 'text_delta':
      return event.delta ? [{ type: 'text', delta: event.delta }] : []
    case 'tool_use':
      return [{ type: 'progress', text: progressLine(event.toolName, event.input, cwd) }]
    case 'notice':
      return event.level === 'info' ? [] : [{ type: 'progress', text: event.message.slice(0, 160) }]
    case 'error':
      return [{ type: 'error', message: event.message }]
    default:
      return []
  }
}
