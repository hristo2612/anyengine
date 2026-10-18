import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOffArgs, runOff } from '../src/control-flip.mjs'
import { type FlipContext, quiet } from '../src/control-flip-recovery.mjs'
import { fakeSystem } from './helpers/fake-system.mjs'
import { scripted } from './helpers/flip-deps.mjs'

const BUSY = { quiet: false, staged: false, text: 'preflip-check: not quiet; wait: busy' }
const QUIET = { quiet: true, staged: false, text: 'preflip-check: quiet' }
const STAGED = {
  quiet: false,
  staged: true,
  text: 'preflip-check: not quiet: an app update is staged and would install on restart',
}
function fixture() {
  const system = fakeSystem('/unused/quiet')
  const { deps } = scripted(system)
  const out: string[] = []
  const ctx: FlipContext = {
    system,
    deps,
    root: '/unused/quiet/.anyengine',
    stop: { requested: null },
    say: (text) => out.push(text),
    marker: () => assert.fail('quiet preflight must not reach a mutation phase'),
  }
  return { ctx, system, deps, out }
}

test('Off cancels a 60-minute quiet wait after SIGTERM before another check or any mutation', async () => {
  const { ctx, system, deps, out } = fixture()
  let checks = 0
  let sleeps = 0
  deps.preflip = () => (++checks === 1 ? BUSY : QUIET)
  system.sleep = async (ms) => {
    assert.equal(ms, 5000)
    sleeps += 1
    ctx.stop.requested = 'SIGTERM'
  }
  const options = parseOffArgs(['--yes', '--foreground', '--wait-quiet', '60'])
  assert.notEqual(typeof options, 'string')
  if (typeof options === 'string') throw new Error(options)
  assert.equal(await runOff(ctx, options), 1)
  assert.equal(checks, 1, 'cancellation must stop before the next preflight probe')
  assert.equal(sleeps, 1)
  assert.match(out.join(''), /off failed: flip interrupted by SIGTERM/)
  assert.deepEqual(system.calls, [])
})

for (const options of [{}, { allowStaged: true }, { allowStaged: true, force: true }])
  test(`normal quiet preflight honors an existing stop: ${JSON.stringify(options)}`, async () => {
    const { ctx, deps } = fixture()
    ctx.stop.requested = 'SIGINT'
    deps.preflip = () => assert.fail('a cancelled operation must not start a preflight probe')
    await assert.rejects(quiet(ctx, 60, options), /flip interrupted by SIGINT/)
  })

test('cancellation observed by a successful probe cannot be bypassed by quiet or force', async () => {
  const { ctx, deps } = fixture()
  deps.preflip = () => {
    ctx.stop.requested = 'SIGTERM'
    return QUIET
  }
  await assert.rejects(quiet(ctx, 60, { allowStaged: true, force: true }), /SIGTERM/)
})

test('actual recovery keeps waiting and completes despite a stop request', async () => {
  const { ctx, system, deps } = fixture()
  ctx.stop.requested = 'SIGTERM'
  let checks = 0
  let sleeps = 0
  deps.preflip = () => (++checks === 1 ? BUSY : QUIET)
  system.sleep = async () => {
    sleeps += 1
  }
  await quiet(ctx, 60, { allowStaged: true, recovering: true })
  assert.equal(checks, 2)
  assert.equal(sleeps, 1)
})

test('Off can still accept a staged-only update, independently of ignoring cancellation', async () => {
  const { ctx, deps } = fixture()
  deps.preflip = () => STAGED
  await quiet(ctx, 0, { allowStaged: true })
  ctx.stop.requested = 'SIGTERM'
  await assert.rejects(quiet(ctx, 0, { allowStaged: true }), /SIGTERM/)
  await quiet(ctx, 0, { allowStaged: true, recovering: true })
})

for (const options of [{ force: true }, { recovering: true, force: true }])
  test(`staged guard requires explicit allowance even under force: ${JSON.stringify(options)}`, async () => {
    const { ctx, deps } = fixture()
    deps.preflip = () => STAGED
    await assert.rejects(quiet(ctx, 0, options), /staged update:/)
  })

for (const detail of ['preflip-check: not quiet; wait: busy', 'preflip-check: cannot tell'])
  test(`a staged update does not hide another quiet-check failure: ${detail}`, async () => {
    const { ctx, deps } = fixture()
    deps.preflip = () => ({ ...STAGED, text: `${STAGED.text}\n${detail}` })
    await assert.rejects(
      quiet(ctx, 0, { allowStaged: true, recovering: true }),
      /app is not quiet:/,
    )
  })

test('first-install admission remains independent of staged and cancellation policies', async () => {
  const { ctx, deps } = fixture()
  const firstInstall: unknown[] = []
  deps.preflip = (seconds, options) => {
    assert.equal(seconds, 30)
    firstInstall.push(options?.firstInstall)
    return QUIET
  }
  await quiet(ctx, 0, { firstInstall: true })
  await quiet(ctx, 0)
  assert.deepEqual(firstInstall, [true, false])
})
