import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ApprovalPolicy,
  type Effect,
  type FileSystemPosture,
  GRANULAR_FLAGS,
  type GranularApproval,
  type Posture,
  type PostureContext,
} from '../../src/posture.mjs'

// A fixed tree, so every probe means the same thing on every host: the real
// /tmp and $TMPDIR only ever appear through `ctx`, never as probe paths.
export interface PostureTree {
  base: string
  ctx: PostureContext
  extra: string
  outside: string
}

export function postureTree(): PostureTree {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'anyengine-posture-')))
  const ctx = {
    cwd: join(base, 'work'),
    tmpdir: join(base, 'tmpdir'),
    slashTmp: join(base, 'slashtmp'),
  }
  const extra = join(base, 'extra')
  const outside = join(base, 'outside')
  for (const dir of [ctx.cwd, ctx.tmpdir, ctx.slashTmp, extra, outside, join(ctx.cwd, '.git')]) {
    mkdirSync(dir, { recursive: true })
  }
  // A link inside the workspace that points out of it (spec 5.5 G1), two
  // dangling ones (a write through either creates its target outside) and a
  // loop (a write through it lands nowhere).
  symlinkSync(outside, join(ctx.cwd, 'escape'))
  symlinkSync(join(outside, 'created.txt'), join(ctx.cwd, 'dangle'))
  symlinkSync('../outside/newdir', join(ctx.cwd, 'dangdir'))
  symlinkSync(join(ctx.cwd, 'loop-b'), join(ctx.cwd, 'loop-a'))
  symlinkSync(join(ctx.cwd, 'loop-a'), join(ctx.cwd, 'loop-b'))
  // `..` after a link applies where the link landed, not to its name: through
  // `sub2`, every one of these lands in <outside>/deep, even where the same
  // name also exists in the workspace (`both.txt`).
  const deep = join(outside, 'deep')
  mkdirSync(join(deep, 'dir'), { recursive: true })
  for (const file of [
    join(deep, 'exists-out.txt'),
    join(deep, 'both.txt'),
    join(ctx.cwd, 'both.txt'),
  ]) {
    writeFileSync(file, '')
  }
  symlinkSync(join(deep, 'dir'), join(ctx.cwd, 'sub2'))
  symlinkSync('sub2/../created2.txt', join(ctx.cwd, 'dl'))
  symlinkSync(`${ctx.cwd}/sub2/../created3.txt`, join(ctx.cwd, 'dl-abs'))
  symlinkSync('sub2/../exists-out.txt', join(ctx.cwd, 'l3'))
  symlinkSync('sub2/../both.txt', join(ctx.cwd, 'l4'))
  return { base, ctx, extra, outside }
}

// The row of test/fixtures/claude-permission-modes.json an effect is judged
// by when the parent is a Claude permission mode.
export type ClaudeColumn = 'read' | 'writeInCwd' | 'writeOutside' | 'net' | 'unbounded'

export interface Probe {
  label: string
  effect: Effect
  claude: ClaudeColumn | null
}

export function probes(tree: PostureTree): Probe[] {
  const { ctx, extra, outside } = tree
  const write = (path: string, claude: ClaudeColumn): Probe => ({
    label: `write ${path}`,
    effect: { kind: 'write', path },
    claude,
  })
  return [
    { label: 'read', effect: { kind: 'read' }, claude: 'read' },
    write(join(ctx.cwd, 'a.txt'), 'writeInCwd'),
    write('sub/b.txt', 'writeInCwd'),
    write(join(ctx.cwd, '.git', 'config'), 'writeInCwd'),
    write(join(ctx.cwd, '.GIT', 'config'), 'writeInCwd'),
    write(join(ctx.cwd, 'escape', 'c.txt'), 'writeOutside'),
    write(join(ctx.cwd, 'dangle'), 'writeOutside'),
    write(join(ctx.cwd, 'dangdir', 'x.txt'), 'writeOutside'),
    write(join(ctx.cwd, 'loop-a', 'x'), 'writeOutside'),
    // Built raw: join() would drop the `..` before the OS sees the link.
    ...['dl', 'dl-abs', 'l3', 'l4', 'escape/../pwn.txt'].map((name) =>
      write(`${ctx.cwd}/${name}`, 'writeOutside'),
    ),
    write('escape/../pwn-rel.txt', 'writeOutside'),
    write(join(extra, 'd.txt'), 'writeOutside'),
    write(join(ctx.slashTmp, 'e.txt'), 'writeOutside'),
    write(join(ctx.tmpdir, 'f.txt'), 'writeOutside'),
    write(join(outside, 'g.txt'), 'writeOutside'),
    { label: 'net', effect: { kind: 'net' }, claude: 'net' },
    { label: 'unbounded', effect: { kind: 'unbounded' }, claude: 'unbounded' },
    { label: 'mcp', effect: { kind: 'mcp' }, claude: null },
  ]
}

function fileSystems(extra: string): FileSystemPosture[] {
  const list: FileSystemPosture[] = [
    { kind: 'read-only' },
    { kind: 'full-access' },
    { kind: 'external' },
  ]
  for (const writableRoots of [[], [extra]]) {
    for (const excludeTmpdirEnvVar of [false, true]) {
      for (const excludeSlashTmp of [false, true]) {
        list.push({ kind: 'workspace-write', writableRoots, excludeTmpdirEnvVar, excludeSlashTmp })
      }
    }
  }
  return list
}

function approvals(): ApprovalPolicy[] {
  const list: ApprovalPolicy[] = ['untrusted', 'on-request', 'never']
  for (let bits = 0; bits < 2 ** GRANULAR_FLAGS.length; bits += 1) {
    const granular = Object.fromEntries(
      GRANULAR_FLAGS.map((flag, index) => [flag, (bits & (1 << index)) !== 0]),
    ) as GranularApproval
    list.push({ granular })
  }
  return list
}

// Every parent posture the property tests walk: 11 file systems x network on
// and off x 35 approval policies x 2 reviewers x plan on and off.
export function* everyPosture(tree: PostureTree): Generator<Posture> {
  for (const fileSystem of fileSystems(tree.extra)) {
    for (const network of [false, true]) {
      for (const approval of approvals()) {
        for (const reviewer of ['user', 'auto_review'] as const) {
          for (const plan of [false, true]) {
            yield { fileSystem, network, approval, reviewer, plan, trust: 'unknown' }
          }
        }
      }
    }
  }
}

export const POSTURE_COUNT = 11 * 2 * 35 * 2 * 2
