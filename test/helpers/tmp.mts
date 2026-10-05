import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Temp directories a suite made, so `after(removeTempDirs)` removes them even
// when an assertion failed half way. scripts/test-hermetic.mjs fails a run
// that leaves anything in TMPDIR.
const made = new Set<string>()

export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  made.add(dir)
  return dir
}

export async function removeTempDirs(): Promise<void> {
  const dirs = [...made]
  made.clear()
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
}
