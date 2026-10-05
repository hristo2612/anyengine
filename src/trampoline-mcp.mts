// Ported from EthanSK/claude-in-codex (MIT) src/codexToolsMcpProxy.js @ e2adced; see THIRD_PARTY_NOTICES.md.
// Changes: exported entry point and AnyEngine's private per-turn socket.
import net from 'node:net'
import { pathToFileURL } from 'node:url'

export function runTrampolineMcp(socketPath: string): void {
  const socket = net.createConnection(socketPath)
  socket.on('error', () => {
    process.stderr.write('anyengine trampoline-mcp: could not reach the Codex tool socket\n')
    process.exit(1)
  })
  socket.on('close', () => process.exit(0))
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const socketPath = process.env.ANYENGINE_TRAMPOLINE_SOCKET ?? ''
  if (!socketPath) {
    process.stderr.write('anyengine trampoline-mcp: ANYENGINE_TRAMPOLINE_SOCKET is not set\n')
    process.exit(1)
  }
  runTrampolineMcp(socketPath)
}
