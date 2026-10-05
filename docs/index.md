---
layout: home

hero:
  name: anyengine
  text: Claude in ChatGPT/Codex. GPT in Claude Code.
  tagline: Use your Claude and ChatGPT subscriptions from either tool. Switch engines in the same conversation and run sub-agents from both providers.
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
    details: One npm setup command installs and verifies the prebuilt runtime. Activation keeps automatic rollback, and Off restores managed settings.
---

AnyEngine connects ChatGPT's Codex workspace and Claude Code, so you can use
your Claude and ChatGPT subscriptions from either tool. Grok is also available
through its experimental CLI backend.

## Install

Install macOS prerequisites and sign in through the official clients, then run:

```bash
npx anyengine-cli@latest setup
```

Open a new terminal afterward and run `anyengine status`. In ChatGPT.app's coding
workspace, pick GPT or Claude. In a new Claude Code session, `/model` lists GPT.
The existing Grok backend remains available when its CLI is configured.

The npm package is `anyengine-cli`; the installed command is `anyengine`.
M1–M3 have passed local acceptance.
See [Getting started](/guide/getting-started),
[Installation and recovery](/guide/deployment), and
[Local acceptance](/evidence/m3-accounts-limits).

AnyEngine uses your existing local official clients and logins. Supply any
API credentials through your own host environment or secret manager. Never
commit credentials, session data or private acceptance logs.

The production runtime remains TypeScript on Node.js 24+. Rust protocol work
is experimental; see [Release readiness](/reference/release-readiness) for
maintainer checks and remaining limits.
