---
layout: home

hero:
  name: anyengine
  text: Your coding app, your choice of engine
  tagline: Use GPT and Claude across ChatGPT.app and Claude Code. Switch engines in one conversation, run mixed agents, and manage your accounts locally.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Control commands
      link: /guide/control
    - theme: alt
      text: View on GitHub
      link: https://github.com/hristo2612/anyengine

features:
  - icon: 🔀
    title: Switch engines
    details: Choose GPT or Claude in the app's model picker and carry conversation context across engine switches.
  - icon: 🤝
    title: Mixed agents
    details: Let GPT and Claude delegate to each other, with results in the existing conversation and agent view.
  - icon: 📊
    title: Accounts and limits
    details: Inspect usage, switch your own ChatGPT accounts, and optionally enable rotation. Rotation and replay start off.
  - icon: ↩️
    title: Managed installation
    details: One setup command builds and verifies the installed runtime. Activation keeps automatic rollback, and Off restores managed settings.
---

## Start from a source checkout

Install macOS prerequisites and sign in through the official clients, then run:

```bash
npm run setup
```

Open a new terminal afterward and run `anyengine status`. In ChatGPT.app's coding
workspace, pick GPT or Claude. In a new Claude Code session, `/model` lists GPT.
The existing Grok backend remains available when its CLI is configured.

M1–M3 are locally accepted and available in this source checkout. A packaged
release is pending; the package is not currently published to npm.
See [Getting started](/guide/getting-started),
[Installation and recovery](/guide/deployment), and
[Local acceptance](/evidence/m3-accounts-limits).

AnyEngine uses your existing local official clients and logins. Supply any
API credentials through your own host environment or secret manager. Never
commit credentials, session data or private acceptance logs.

The production runtime remains TypeScript on Node.js 24+. Rust protocol work
is experimental; see [Release readiness](/reference/release-readiness) for
maintainer checks and remaining limits.
