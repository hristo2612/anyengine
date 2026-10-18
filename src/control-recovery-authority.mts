// Owned physical evidence shared by recovery admission and publication.
import { lstatSync, realpathSync } from 'node:fs'
import { digest, regularBytes } from './control-layer-state.mjs'

export function directDirectory(path: string): void {
  const stat = lstatSync(path)
  if (
    !stat.isDirectory() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error('unsafe retained recovery directory; preserve existing authority')
}
export function evidence(path: string, mode?: number): { identity: string; bytes: Buffer } {
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    (mode !== undefined && (stat.mode & 0o7777) !== mode)
  )
    throw new Error('unsafe retained recovery file; preserve existing authority')
  const bytes = regularBytes(path, 2_000_000)
  return {
    bytes,
    identity: [
      stat.dev,
      stat.ino,
      stat.uid,
      stat.mode,
      stat.mtimeMs,
      stat.ctimeMs,
      digest(bytes),
    ].join(':'),
  }
}
