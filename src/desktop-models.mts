// Desktop accepts Claude-compatible gateway IDs; display labels stay truthful.

import type { ClaudeModelEntry } from './anyengine-config.mjs'
import type { GptModel } from './claude-models.mjs'
import { CLAUDE_EFFORTS, type DesktopClaudeModel } from './desktop-claude-catalog.mjs'

export const DESKTOP_MODEL_PREFIX = 'anyengine/claude-compatible/'
export const DESKTOP_CLAUDE_PREFIX = 'anyengine/claude-subscription/'
export const desktopClaudeId = (id: string) => `${DESKTOP_CLAUDE_PREFIX}${id}`
export function desktopClaudeName(model: ClaudeModelEntry): string {
  const resolved = (model as Partial<DesktopClaudeModel>).resolvedModel
  return resolved?.startsWith('claude-') ? resolved : desktopClaudeId(model.id)
}
export function desktopModelId(model: string): string {
  return `${DESKTOP_MODEL_PREFIX}${Buffer.from(model).toString('hex')}`
}
export function desktopGptModel(value: string): string | null {
  const suffix = value.slice(DESKTOP_MODEL_PREFIX.length)
  if (!value.startsWith(DESKTOP_MODEL_PREFIX) || !/^(?:[0-9a-f]{2}){4,128}$/.test(suffix))
    return null
  const model = Buffer.from(suffix, 'hex').toString('utf8')
  return /^gpt-[a-z0-9][a-z0-9.-]*$/.test(model) && desktopModelId(model) === value ? model : null
}
export function desktopProfile(
  port: number,
  models: readonly GptModel[],
  claudeModels: readonly ClaudeModelEntry[] = [],
  nativeNames = false,
) {
  return {
    inferenceProvider: 'gateway',
    inferenceCredentialKind: 'static',
    inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
    // A local placeholder satisfies Desktop's form; vendor credentials stay in the router.
    inferenceGatewayApiKey: 'anyengine-local',
    inferenceGatewayAuthScheme: 'bearer',
    modelDiscoveryEnabled: false,
    modelCatalogEnabled: false,
    inferenceModels: [
      ...claudeModels
        .filter(
          (model, index) =>
            !nativeNames ||
            !claudeModels
              .slice(index + 1)
              .some(
                (next) =>
                  (next as Partial<DesktopClaudeModel>).resolvedModel ===
                  (model as Partial<DesktopClaudeModel>).resolvedModel,
              ),
        )
        .map((model) => {
          const native = model as Partial<DesktopClaudeModel>
          const family = /claude-(sonnet|opus|haiku|fable|mythos)-/.exec(
            native.resolvedModel ?? '',
          )?.[1]
          const maximum =
            native.efforts === undefined
              ? 'high'
              : [...CLAUDE_EFFORTS].reverse().find((level) => native.efforts?.includes(level))
          return {
            name: nativeNames ? desktopClaudeName(model) : desktopClaudeId(model.id),
            labelOverride: model.displayName,
            ...(maximum ? { maxEffort: maximum } : {}),
            ...(family ? { anthropicFamilyTier: family } : {}),
            ...(native.resolvedModel && model.claudeModel.endsWith('[1m]')
              ? { supports1m: true }
              : {}),
          }
        }),
      ...models.map((model) => ({
        name: desktopModelId(model.id),
        labelOverride: model.label,
        maxEffort:
          ['max', 'xhigh', 'high', 'medium', 'low'].find((level) =>
            model.efforts.includes(level),
          ) ?? 'low',
      })),
    ],
    chatTabEnabled: true,
    isClaudeCodeForDesktopEnabled: true,
  }
}
