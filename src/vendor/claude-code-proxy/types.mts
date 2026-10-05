import type { ModelChoice } from '../../claude-models.mjs'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Obj = { [key: string]: Json }

export interface TranslationContext {
  model: ModelChoice
  sessionKey: string
}

export interface StreamEvent {
  event: string
  data: Obj
}

export interface TranslationFailure {
  status: number
  type: string
  code: string
  message: string
  retryAfter: string | null
}
