#!/usr/bin/env node
// Launcher for the `anyengine` MCP server (same as `node dist/src/adapter.mjs
// bridge-mcp`). The adapter configures every engine with the adapter entry
// directly; this file is for hand-written MCP configs (docs/guide/bridge.md).
import { runBridgeMcp } from '../dist/src/bridge-mcp.mjs'

await runBridgeMcp()
