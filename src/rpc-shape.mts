export const THREAD_ID_KEYS = ['threadId', 'thread_id'] as const

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// Thread-scoped params carry `threadId` (v2) or `thread_id` (legacy v1).
export function threadIdOf(params: Record<string, unknown>): string | null {
  for (const key of THREAD_ID_KEYS) {
    const value = params[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

// A `Thread` object (thread/started, thread/list rows, thread/start result).
export function idOf(thread: Record<string, unknown>): string | null {
  return typeof thread.id === 'string' && thread.id.length > 0 ? thread.id : null
}
