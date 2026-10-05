// launchd state is positive evidence: an unknown query or failed mutation throws.
import { isAbsolute, join } from 'node:path'
import type { ExecResult, System } from './control-system.mjs'

export const ROUTER_LABEL = 'dev.anyengine.router'
export const SMOKE_LABEL = 'dev.anyengine.smoke'
export function plistPath(home: string, label: string): string {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`)
}
interface JobInput {
  root: string
  launcher: string
  node: string
  pathDirs: string[]
  log: string
}
const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function valueXml(value: unknown): string {
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>'
  if (typeof value === 'number') return `<integer>${value}</integer>`
  if (typeof value === 'string') {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error('invalid XML string')
    return `<string>${xml(value)}</string>`
  }
  if (Array.isArray(value)) return `<array>${value.map(valueXml).join('\n')}</array>`
  return `<dict>${Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `<key>${xml(key)}</key>\n${valueXml(entry)}`)
    .join('\n')}</dict>`
}
function job(
  input: JobInput,
  label: string,
  args: string[],
  extra: Record<string, unknown>,
): string {
  if (!isAbsolute(input.root)) throw new Error('launchd root must be an absolute path')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${valueXml(
    {
      Label: label,
      ProgramArguments: ['/bin/bash', input.launcher, ...args],
      RunAtLoad: true,
      EnvironmentVariables: {
        ANYENGINE_ROOT: input.root,
        ANYENGINE_NODE: input.node,
        PATH: [...input.pathDirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
        ANYENGINE_LAUNCHD_LOG: input.log,
      },
      StandardOutPath: input.log,
      StandardErrorPath: input.log,
      ...extra,
    },
  )}</plist>\n`
}
export function routerPlist(input: JobInput): string {
  return job(input, ROUTER_LABEL, ['router'], { KeepAlive: true, ThrottleInterval: 5 })
}
export function smokePlist(
  input: JobInput & { hour: number; minute: number; watchPaths: string[] },
): string {
  if (
    !Number.isInteger(input.hour) ||
    input.hour < 0 ||
    input.hour > 23 ||
    !Number.isInteger(input.minute) ||
    input.minute < 0 ||
    input.minute > 59
  )
    throw new Error('invalid smoke schedule')
  return job(input, SMOKE_LABEL, ['smoke', '--scheduled', '--notify'], {
    RunAtLoad: false,
    StartCalendarInterval: { Hour: input.hour, Minute: input.minute },
    WatchPaths: input.watchPaths,
    ProcessType: 'Background',
  })
}
const domain = () => `gui/${process.getuid?.() ?? 0}`
const service = (label: string) => `${domain()}/${label}`
function checked(result: ExecResult, action: string): ExecResult {
  if (result.status !== 0 || result.stderr.trim())
    throw new Error(
      `launchctl ${action} failed (status ${result.status ?? 'unknown'}): ${result.stderr}`,
    )
  return result
}
export function jobLoaded(system: System, label: string): boolean {
  const result = system.launchctl(['print', service(label)])
  if (result.status === 113 && !result.stdout.trim()) {
    const expected = `Bad request.\nCould not find service "${label}" in domain for user gui: ${process.getuid?.() ?? 0}`
    if (result.stderr.trim() === expected) {
      checked(system.launchctl(['print', domain()]), 'print domain')
      return false
    }
  }
  checked(result, `print ${label}`)
  return true
}
export function unloadJob(system: System, label: string): void {
  if (system.appRunning()) throw new Error('configured app must exit before unloading jobs')
  if (!jobLoaded(system, label)) return
  const result = system.launchctl(['bootout', service(label)])
  if (result.status === 0) {
    checked(result, `bootout ${label}`)
  } else {
    if (!jobLoaded(system, label)) return // A positive absence query resolves the race.
    checked(result, `bootout ${label}`)
  }
  for (let attempt = 0; attempt <= 60; attempt += 1) {
    if (!jobLoaded(system, label)) return
    if (attempt < 60) checked(system.exec('/bin/sleep', ['0.5']), `wait for bootout ${label}`)
  }
  throw new Error(`launchctl bootout ${label}: job absence not proven`)
}
export function loadJob(system: System, label: string, plist: string): ExecResult {
  if (jobLoaded(system, label)) unloadJob(system, label)
  return checked(system.launchctl(['bootstrap', domain(), plist]), `bootstrap ${label}`)
}
export function reloadJob(system: System, label: string): ExecResult {
  return checked(system.launchctl(['kickstart', '-k', service(label)]), `kickstart ${label}`)
}
