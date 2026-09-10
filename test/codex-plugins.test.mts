import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  codexPluginMarketplaces,
  codexPluginMcpServers,
  enabledPluginRefs,
  findCodexPlugin,
  listCodexPlugins,
  readPluginSkill,
  withCodexPluginMcpServers,
} from '../src/codex-plugins.mjs'

// A CODEX_HOME shaped exactly like the real one: config.toml with `[plugins]`
// blocks, and materialised packages under plugins/cache/<market>/<name>/<ver>/.
async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-plugins-'))
  await writeFile(
    join(home, 'config.toml'),
    [
      'model = "sonnet"',
      '',
      '[plugins."jinn@personal"]',
      'enabled = true',
      '',
      '[plugins."visualize@openai-bundled"]',
      'enabled = true',
      '',
      '[plugins."retired@personal"]',
      'enabled = false',
      '',
      '[plugins."halfway@personal"]',
      '',
      '[tui]',
      'theme = "dark"',
      '',
    ].join('\n'),
  )

  const jinn = join(home, 'plugins', 'cache', 'personal', 'jinn', '0.0.2')
  await mkdir(join(jinn, '.codex-plugin'), { recursive: true })
  await mkdir(join(jinn, 'skills', 'jimbo'), { recursive: true })
  await writeFile(
    join(jinn, '.codex-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'jinn',
      version: '0.0.2',
      description: 'One memory, every engine.',
      interface: { displayName: 'Jinn' },
    }),
  )
  await writeFile(
    join(jinn, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        jinn: {
          command: process.execPath,
          args: ['mcp'],
          env: { JINN_HOME: '/tmp/jinn-home' },
        },
      },
    }),
  )
  await writeFile(join(jinn, 'skills', 'jimbo', 'SKILL.md'), '# Jimbo\n')
  // An older version of the same plugin must lose to 0.0.2.
  await mkdir(join(home, 'plugins', 'cache', 'personal', 'jinn', '0.0.1'), { recursive: true })

  const visualize = join(home, 'plugins', 'cache', 'openai-bundled', 'visualize', '1.0.0')
  await mkdir(visualize, { recursive: true })
  await writeFile(
    join(visualize, '.mcp.json'),
    JSON.stringify({
      mcpServers: { visualize: { command: './bin/launcher', args: ['mcp'] } },
    }),
  )
  return home
}

test('enabledPluginRefs reads only the blocks that say enabled = true', async () => {
  const home = await fixtureHome()
  try {
    assert.deepEqual(enabledPluginRefs(home), [
      { name: 'jinn', marketplace: 'personal' },
      { name: 'visualize', marketplace: 'openai-bundled' },
    ])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('listCodexPlugins resolves the newest package, its manifest and its mcp servers', async () => {
  const home = await fixtureHome()
  try {
    const plugins = listCodexPlugins(home)
    const jinn = findCodexPlugin(plugins, 'jinn')
    assert.ok(jinn)
    assert.equal(jinn.version, '0.0.2')
    assert.match(String(jinn.dir), /0\.0\.2$/)
    assert.deepEqual(jinn.skills, ['jimbo'])
    assert.equal(jinn.description, 'One memory, every engine.')
    assert.deepEqual(jinn.display, { displayName: 'Jinn' })

    const visualize = plugins.find((p) => p.name === 'visualize')
    assert.ok(visualize)
    assert.equal(visualize.marketplace, 'openai-bundled')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('plugin/list marketplaces carry every field the app-server schema requires', async () => {
  const home = await fixtureHome()
  try {
    const marketplaces = codexPluginMarketplaces(listCodexPlugins(home))
    assert.equal(marketplaces.length, 2)
    const personal = marketplaces.find((m) => m.name === 'personal')
    assert.ok(personal)
    const summary = (personal.plugins as Array<Record<string, unknown>>)[0]
    assert.ok(summary)
    for (const key of [
      'authPolicy',
      'enabled',
      'id',
      'installPolicy',
      'installed',
      'name',
      'source',
    ]) {
      assert.ok(key in summary, `missing required PluginSummary field ${key}`)
    }
    assert.equal(summary.name, 'jinn')
    assert.equal(summary.enabled, true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('only the user own marketplaces contribute stdio mcp servers, env included', async () => {
  const home = await fixtureHome()
  try {
    const servers = codexPluginMcpServers(listCodexPlugins(home)) as Record<
      string,
      Record<string, unknown>
    >
    // `visualize` is an openai-bundled package whose launcher is a Codex-only
    // relative path; it must never be handed to `claude` or `grok`.
    assert.deepEqual(Object.keys(servers), ['jinn'])
    assert.equal(servers.jinn?.command, process.execPath)
    assert.deepEqual(servers.jinn?.env, { JINN_HOME: '/tmp/jinn-home' })
    assert.equal(servers.jinn?.type, 'stdio')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('withCodexPluginMcpServers never shadows a server the app already provided', async () => {
  const home = await fixtureHome()
  try {
    const merged = withCodexPluginMcpServers(
      { jinn: { command: '/app/provided', args: [] }, anyengine: { command: '/bridge' } },
      home,
    ) as Record<string, Record<string, unknown>>
    assert.equal(merged.jinn?.command, '/app/provided')
    assert.equal(merged.anyengine?.command, '/bridge')

    const wrapped = withCodexPluginMcpServers({ mcpServers: {} }, home) as {
      mcpServers: Record<string, unknown>
    }
    assert.deepEqual(Object.keys(wrapped.mcpServers), ['jinn'])

    process.env.ANYENGINE_CODEX_PLUGIN_MCP = '0'
    try {
      assert.deepEqual(withCodexPluginMcpServers({}, home), {})
    } finally {
      delete process.env.ANYENGINE_CODEX_PLUGIN_MCP
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('readPluginSkill returns SKILL.md and null for a skill that is not there', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-plugins-'))
  try {
    await writeFile(join(home, 'config.toml'), '[plugins."jinn@personal"]\nenabled = true\n')
    const dir = join(home, 'plugins', 'cache', 'personal', 'jinn', '1.0.0', 'skills', 'jimbo')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '# Jimbo\nbody\n')
    const plugin = findCodexPlugin(listCodexPlugins(home), 'jinn@personal')
    assert.ok(plugin)
    assert.deepEqual(plugin.skills, ['jimbo'])
    assert.equal(readPluginSkill(plugin, 'jimbo'), '# Jimbo\nbody\n')
    assert.equal(readPluginSkill(plugin, 'nope'), null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a CODEX_HOME with no config.toml lists nothing instead of throwing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anyengine-plugins-'))
  try {
    assert.deepEqual(listCodexPlugins(home), [])
    assert.deepEqual(codexPluginMarketplaces(listCodexPlugins(home)), [])
    assert.deepEqual(withCodexPluginMcpServers({ a: 1 }, home), { a: 1 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
