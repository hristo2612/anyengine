#!/usr/bin/env node
// Standalone stdio connector: stdout is reserved for MCP messages.
import { anyengineRoot } from '../dist/src/anyengine-config.mjs'
import { runDesktopMcp } from '../dist/src/desktop-mcp.mjs'

runDesktopMcp(anyengineRoot())
