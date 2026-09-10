// The marketplace and plugin-share half of the protocol surface.
//
// Every function here is a pure params-in / payload-out mapping: the desktop
// asks, the adapter answers in the shape the schema promises, and nothing is
// read or written outside the Codex plugin catalog. That is why they are plain
// functions rather than methods — they never needed the server at all.
import { findCodexPlugin, listCodexPlugins, pluginDetail } from './codex-plugins.mjs'
import { asRecord, stringOr } from './server-helpers.mjs'
import { codexHome, newId } from './util.mjs'

export function marketplaceAdd(params: Record<string, unknown>): unknown {
  const source = stringOr(params.source, 'local')
  const marketplaceName = stringOr(
    params.refName,
    source.split('/').filter(Boolean).at(-1) ?? 'marketplace',
  )
  return {
    marketplaceName,
    installedRoot: `${codexHome()}/marketplaces/${marketplaceName}`,
    alreadyAdded: true,
  }
}

export function marketplaceRemove(params: Record<string, unknown>): unknown {
  const marketplaceName = stringOr(params.marketplaceName, 'marketplace')
  return { marketplaceName, installedRoot: null }
}

export function marketplaceUpgrade(params: Record<string, unknown>): unknown {
  const marketplaceName = typeof params.marketplaceName === 'string' ? params.marketplaceName : null
  return {
    selectedMarketplaces: marketplaceName ? [marketplaceName] : [],
    upgradedRoots: [],
    errors: [],
  }
}

export function pluginShareSave(params: Record<string, unknown>): unknown {
  const remotePluginId = stringOr(params.remotePluginId, `local-${newId()}`)
  return {
    remotePluginId,
    shareUrl: `https://localhost.invalid/anyengine/plugin-share/${encodeURIComponent(remotePluginId)}`,
  }
}

export function pluginShareUpdateTargets(params: Record<string, unknown>): unknown {
  const shareTargets = Array.isArray(params.shareTargets) ? params.shareTargets : []
  return {
    principals: shareTargets.map((target) => {
      const rec = asRecord(target)
      return {
        principalType: stringOr(rec.principalType, 'user'),
        principalId: stringOr(rec.principalId, ''),
        name: stringOr(rec.principalId, 'unknown'),
      }
    }),
    discoverability: params.discoverability === 'UNLISTED' ? 'UNLISTED' : 'PRIVATE',
  }
}

export function pluginRead(params: Record<string, unknown>): unknown {
  const name = stringOr(params.pluginName, 'unknown')
  const known = findCodexPlugin(
    listCodexPlugins(),
    name,
    stringOr(params.remoteMarketplaceName, '') || null,
  )
  if (known) return { plugin: pluginDetail(known) }
  return {
    plugin: {
      marketplaceName: stringOr(params.remoteMarketplaceName, 'local'),
      marketplacePath: params.marketplacePath ?? null,
      summary: {
        id: name,
        name,
        shareContext: null,
        source: { type: 'remote' },
        installed: false,
        enabled: false,
        installPolicy: 'NOT_AVAILABLE',
        authPolicy: 'ON_USE',
        availability: 'AVAILABLE',
        interface: null,
        keywords: [],
      },
      description: null,
      skills: [],
      hooks: [],
      apps: [],
      appTemplates: [],
      mcpServers: [],
    },
  }
}
