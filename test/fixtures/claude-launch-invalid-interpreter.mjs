// Run only in a private subprocess: older Node 24 can abort on execve OS errors.
import { createClaudeLaunchCommand } from '../../dist/src/control-claude-launch.mjs'

const root = process.argv[2]
if (!root) throw new Error('private invalid-interpreter fixture root required')
// The real command does not use System; no app, auth or Mac action is reachable.
process.exitCode = await createClaudeLaunchCommand()(
  ['--', '-p', 'invalid-interpreter-fixture'],
  {},
  root,
  (text) => process.stderr.write(text),
)
