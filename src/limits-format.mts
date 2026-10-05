import type { AccountRegistry } from './accounts-types.mjs'
import { type ClaudeReading, formatClaudeLimits } from './limits-claude.mjs'
import { blocked, exhaustedUntil, type LimitState, type WindowReading } from './limits-openai.mjs'

function reading(w: WindowReading | null | undefined): string {
  if (!w || typeof w.usedPercent !== 'number') return '—'
  const reset =
    typeof w.resetsAt === 'number' ? `, resets ${new Date(w.resetsAt * 1000).toISOString()}` : ''
  return `${w.usedPercent}%${reset}`
}
export function limitsRows(
  registry: AccountRegistry,
  all: Record<string, LimitState>,
  now = Date.now(),
) {
  return registry.accounts.map((a) => {
    const state = all[a.id],
      buckets = state?.buckets ?? {}
    const ordinary = buckets.codex?.value
    const windows = [ordinary?.primary, ordinary?.secondary].filter((w) => w != null)
    return {
      id: a.id,
      label: a.label,
      vendor: 'openai',
      state:
        a.login === 'needs-login'
          ? 'needs login'
          : blocked(state ?? ({ denials: {} } as LimitState), 'global')
            ? 'exhausted'
            : registry.active === a.id
              ? 'active'
              : 'parked',
      exhaustedUntil: state ? exhaustedUntil(state) : null,
      fiveHour: windows.find((w) => w?.windowDurationMins === 300) ?? null,
      weekly: windows.find((w) => w?.windowDurationMins === 10080) ?? null,
      buckets,
      ordinaryUsageAllowed: state?.ordinary?.value ?? null,
      credits: ordinary?.credits ?? null,
      resetCredits: state?.resetCredits?.value ?? null,
      observedAt: state?.lastSuccessAt ?? null,
      ageMs: state?.lastSuccessAt == null ? null : Math.max(0, now - state.lastSuccessAt),
      error: state?.error ?? null,
      denials: state?.denials ?? {},
      fieldTimes: state?.fieldTimes ?? {},
    }
  })
}
export function formatLimits(
  registry: AccountRegistry,
  all: Record<string, LimitState>,
  now = Date.now(),
  claude: Record<string, ClaudeReading> = {},
): string {
  const lines = ['Account | State | 5-hour | Weekly | Credits | Age']
  for (const row of limitsRows(registry, all, now)) {
    const credits = row.credits?.unlimited ? 'unlimited' : (row.credits?.balance ?? '—')
    const age = row.ageMs == null ? 'not observed' : `${Math.floor(row.ageMs / 1000)}s`
    lines.push(
      `${row.label} (${row.id}) | ${row.state}${row.exhaustedUntil !== null ? ` until ${new Date(row.exhaustedUntil).toISOString()}` : ''} | ${reading(row.fiveHour)} | ${reading(row.weekly)} | ${credits} | ${age}`,
    )
    for (const [id, b] of Object.entries(row.buckets))
      if (id !== 'codex')
        lines.push(
          `  ${id}${b.value.normalModelSlug ? ` (${b.value.normalModelSlug})` : ''}: ${reading(b.value.primary)}; ${reading(b.value.secondary)}`,
        )
  }
  lines.push(formatClaudeLimits(claude, now))
  return `${lines.join('\n')}\n`
}
