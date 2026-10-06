// Desktop accepts Claude-compatible gateway IDs; display labels stay truthful.
import type { GptModel } from './claude-models.mjs'

export const DESKTOP_MODEL_PREFIX = 'anyengine/claude-compatible/'
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
export function desktopProfile(port: number, models: readonly GptModel[]) {
  return {
    inferenceProvider: 'gateway',
    inferenceCredentialKind: 'static',
    inferenceGatewayBaseUrl: `http://127.0.0.1:${port}`,
    // A local placeholder satisfies Desktop's form; vendor credentials stay in the router.
    inferenceGatewayApiKey: 'anyengine-local',
    inferenceGatewayAuthScheme: 'bearer',
    modelDiscoveryEnabled: false,
    modelCatalogEnabled: false,
    inferenceModels: models.map((model) => ({
      name: desktopModelId(model.id),
      labelOverride: model.label,
      maxEffort:
        ['max', 'xhigh', 'high', 'medium', 'low'].find((level) => model.efforts.includes(level)) ??
        'low',
    })),
    chatTabEnabled: true,
    isClaudeCodeForDesktopEnabled: true,
  }
}
