import { spawn } from 'node:child_process'

const order = process.argv[2]
if (order === 'timeout' || order === 'grandchild') setInterval(() => {}, 1000)
else {
  if (order === 'family')
    spawn(process.execPath, [process.argv[1], 'grandchild'], { stdio: 'ignore' }).unref()
  process.stdout.write(order === 'malformed' ? 'invalid\n' : '{"type":"turn.completed"}\n')
  process.exitCode = order === 'failed' ? 2 : 0
}
