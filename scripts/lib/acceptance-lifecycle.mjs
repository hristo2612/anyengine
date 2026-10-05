// Cleanup attempts are independent; unresolved ownership always retains evidence.
import { lstatSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function settleAcceptance(ctx) {
  const status = {}
  let failure = ctx.error
  const attempt = async (name, work) => {
    try {
      await work()
      status[name] = true
    } catch (error) {
      failure ??= error
      status[name] = false
    }
  }
  await attempt('release', async () => {
    ctx.processes.sample()
    if (ctx.threads) {
      ctx.collect()
      await ctx.threads.release()
    }
  })
  await attempt('client', () => ctx.client?.close())
  await attempt('processes', () => ctx.processes.close())
  await attempt('threads', () => {
    if (ctx.threads) {
      ctx.collect()
      ctx.threads.verify(ctx.work)
    }
  })
  await attempt('sessions', ctx.pruneSessions)
  await attempt('files', ctx.cleanupFiles)
  await attempt('frozen', ctx.verify)
  ctx.threads?.detach()
  if (!ctx.settled) failure ??= new Error('acceptance work did not settle')
  const now = lstatSync(ctx.work)
  if (!now.isDirectory() || now.dev !== ctx.stamp.dev || now.ino !== ctx.stamp.ino)
    throw new Error('acceptance scratch identity changed')
  if (failure) {
    writeFileSync(join(ctx.work, 'acceptance-cleanup.json'), `${JSON.stringify(status)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    throw failure
  }
  rmSync(ctx.work, { recursive: true })
  return status
}
