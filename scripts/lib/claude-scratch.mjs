// Where a live Claude run (the probes, the smokes) works and keeps its state.
// Claude works in one fixed project folder, so Claude Code adds one project
// entry to ~/.claude.json, once; the run never opens that file. The run's own
// state (adapter home, debug log, the relay's hook settings and MCP config in
// ANYENGINE_PTY_STATE_DIR) sits in a scratch folder next to the project,
// outside every root the thread may write (the project, TMPDIR and /tmp), so
// a sandboxed command cannot reach it.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// `--project DIR` or `--project=DIR`, else `fallback` (none: null); anything
// else, or no folder at all, prints `usage` and exits 2.
export function projectFromArgs(argv, fallback, usage) {
  let project = fallback || null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--project' && argv[i + 1]) project = argv[++i]
    else if (arg.startsWith('--project=')) project = arg.slice('--project='.length)
    else project = null
    if (!project) break
  }
  if (!project) {
    console.error(usage)
    process.exit(2)
  }
  return resolve(project)
}

// A new scratch folder `<prefix>XXXXXX` next to `project`; refused (exit 2,
// `name` in the message) where it would land in TMPDIR or /tmp.
export function scratchNextTo(project, prefix, name) {
  const dir = realpathSync(mkdtempSync(join(dirname(project), prefix)))
  const roots = [tmpdir(), '/tmp'].map((root) => {
    try {
      return realpathSync(root)
    } catch {
      return root
    }
  })
  if (roots.some((root) => dir === root || dir.startsWith(`${root}/`))) {
    rmSync(dir, { recursive: true, force: true })
    console.error(`${name}: ${dirname(project)} is inside TMPDIR or /tmp; use another --project`)
    process.exit(2)
  }
  return dir
}
