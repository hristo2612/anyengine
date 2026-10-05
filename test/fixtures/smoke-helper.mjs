// Controlled one-shot peer: no vendor CLI, credentials, network or model work.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [attempt, root] = process.argv.slice(2)
const mode = process.env.FAKE_SMOKE_HELPER_MODE
const oauth = {
  loggedIn: true,
  method: 'claude.ai',
  home: '/controlled/home',
  executable: '/controlled/cli',
  identity: 'a'.repeat(64),
  version: '2.1.288 (Claude Code)',
}
const result = {
  sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  responseId: 'resp_controlled',
  exitCode: 0,
  oauth: { before: oauth, after: oauth },
  model: 'haiku',
  completedAt: new Date().toISOString(),
  success: true,
  status: 'completed',
}
process.on('message', (message) => {
  if (message.phase === 'before') {
    if (mode === 'timeout') {
      process.on('SIGTERM', () => {})
      const child = spawn(
        process.execPath,
        [
          '-e',
          'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
      child.stdout.once('data', () =>
        writeFileSync(join(root, 'family.json'), JSON.stringify({ pid: child.pid })),
      )
      return
    }
    if (mode === 'disconnect') return process.disconnect()
    if (mode === 'exit') return process.exit(0)
    process.send({
      attempt: mode === 'wrong-attempt' ? 'foreign' : attempt,
      phase: mode === 'replay' ? 'before' : 'after',
      result: mode === 'oversized' ? { text: 'x'.repeat(17000) } : result,
    })
  } else {
    if (!message.ok) process.exitCode = 1
    process.disconnect()
  }
})
process.send({ attempt, phase: 'before' })
