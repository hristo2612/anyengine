import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { GptSettingsView } from './claude-models.mjs'
import { applyClaudeLayer } from './control-claude-layer.mjs'
import { flipPaths } from './control-flip-options.mjs'
import type { FlipContext } from './control-flip-recovery.mjs'
import { configAt, type OnPlan, persistRecord } from './control-install-on.mjs'
import { jsonAt } from './control-layer-state.mjs'
import { LayerWriter, readLayers } from './control-layers.mjs'
import {
  activeUpgrade,
  prepareM2Upgrade,
  readM2Baseline,
  refreshM2LayersHash,
  setM2UpgradePhase,
} from './control-m2-upgrade.mjs'
import { shellQuote } from './control-scripts.mjs'
import { fetchGptSettingsView, settingsView } from './router-messages.mjs'

export function previewClaudeCode(ctx: FlipContext): void {
  try {
    const view = settingsView(jsonAt(join(ctx.root, 'router/claude-gpt-catalog.json')))
    const age = ctx.system.now().getTime() - view.fetchedAt
    if (age < 0) throw new Error('future catalog')
    ctx.say(
      `Claude preview: last verified catalog is ${Math.floor(age / 1000)}s old; activation requires a fresh catalog\n`,
    )
    ctx.say(`would merge ${join(ctx.system.home, '.claude/settings.json')}\n`)
    for (const model of view.models)
      ctx.say(
        `would add picker ${model.id} (${model.label}) and agent ${join(ctx.system.home, '.claude/agents', `${model.id}.md`)} unless unowned\n`,
      )
  } catch {
    ctx.say(
      'Claude preview: no valid verified catalog; activation requires a fresh catalog before settings change\n',
    )
  }
}

export function prepareClaudeUpgrade(ctx: FlipContext, plan: OnPlan): void {
  const milestone = existsSync(join(plan.libDir, 'dist/src/accounts-bootstrap.mjs')) ? 'm3' : 'm2'
  const baseline = prepareM2Upgrade(ctx.system, ctx.root, plan, milestone)
  ctx.marker('prepare', {
    failureTarget: milestone,
    [`${milestone}BaselineId`]: basename(baseline.rollbackDir),
    recoveryCommand: `/bin/bash ${shellQuote(join(ctx.root, 'recovery', milestone, 'recover.sh'))}`,
  })
  ctx.say(
    `${milestone.toUpperCase()} recovery: /bin/bash ${shellQuote(join(ctx.root, 'recovery', milestone, 'recover.sh'))}\n`,
  )
}
export async function installClaudeCode(ctx: FlipContext, plan: OnPlan): Promise<void> {
  const baseUrl = `http://127.0.0.1:${configAt(ctx.root).router.port}`
  const catalog: GptSettingsView = await fetchGptSettingsView(baseUrl, new AbortController().signal)
  if (!catalog.models.length) throw new Error('no available GPT models; Claude settings unchanged')
  const file = readLayers(ctx.root)
  const existing = file.layers.find((layer) => layer.name === 'claude-code')
  const baseline = readM2Baseline(ctx.root, activeUpgrade(ctx.root))
  const retainedBaseline = baseline && baseline.phase !== 'rolled-back'
  const writer = new LayerWriter(
    ctx.root,
    existing ?? null,
    'claude-code',
    plan.stamp,
    persistRecord(ctx.root, ctx.system, plan, flipPaths(ctx.system), file.layers),
  )
  applyClaudeLayer({
    root: ctx.root,
    home: ctx.system.home,
    writer,
    catalog,
    baseUrl,
    haiku: 'claude-haiku-4-5-20251001',
    checkpoint:
      Boolean(existing && file.layers.some((layer) => layer.upgrade)) && !retainedBaseline,
  })
  for (const model of catalog.models) {
    const target = join(ctx.system.home, '.claude/agents', `${model.id}.md`)
    if (!writer.layer.changes.some((change) => change.target === target))
      ctx.say(`Claude agent collision retained: ${target}\n`)
  }
  if (retainedBaseline) refreshM2LayersHash(ctx.root, activeUpgrade(ctx.root))
}
export function finishClaudeUpgrade(root: string): void {
  refreshM2LayersHash(root, activeUpgrade(root))
  setM2UpgradePhase(root, 'active', activeUpgrade(root))
}
