#!/usr/bin/env node
// npm does not publish package-lock.json. Ship the same dependency pins as a CLI lockfile.
import { copyFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = resolve(source, 'npm-shrinkwrap.json')
if (process.argv.includes('--clean')) rmSync(lock, { force: true })
else copyFileSync(resolve(source, 'package-lock.json'), lock)
