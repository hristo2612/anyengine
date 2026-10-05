import { defineConfig } from 'vitepress'

const repo = 'https://github.com/hristo2612/anyengine'

export default defineConfig({
  title: 'anyengine',
  description:
    'Use Claude in ChatGPT/Codex and GPT in Claude Code with your existing subscriptions.',
  base: '/anyengine/',
  lastUpdated: true,
  cleanUrls: true,
  srcExclude: ['drafts/**'],
  ignoreDeadLinks: true,
  head: [['meta', { name: 'theme-color', content: '#d97757' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/protocol-coverage' },
      { text: 'RFCs', link: '/rfcs/rust-first-runtime' },
      { text: 'Contributing', link: '/contributing' },
      { text: 'Quality gates', link: '/quality' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Installation and recovery', link: '/guide/deployment' },
            { text: 'Using ChatGPT.app', link: '/guide/gui' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Backends', link: '/guide/backends' },
            { text: 'Cross-engine bridge', link: '/guide/bridge' },
            { text: 'Session browsing and cross-open', link: '/guide/sessions' },
            { text: 'Router', link: '/guide/router' },
            { text: 'GPT in Claude Code', link: '/guide/claude-code' },
            { text: 'Control commands', link: '/guide/control' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Protocol coverage', link: '/reference/protocol-coverage' },
            { text: 'Capability matrix', link: '/reference/capability-matrix' },
            { text: 'Validation', link: '/reference/validation' },
            { text: 'Workflow operations', link: '/reference/workflow-operations' },
            { text: 'Release readiness', link: '/reference/release-readiness' },
          ],
        },
      ],
      '/rfcs/': [
        {
          text: 'RFCs',
          items: [
            { text: 'Rust-first runtime boundaries', link: '/rfcs/rust-first-runtime' },
            {
              text: 'Provider and multi-agent loop boundaries',
              link: '/rfcs/provider-and-agent-loop-boundaries',
            },
          ],
        },
      ],
    },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © anyengine contributors',
    },
  },
})
