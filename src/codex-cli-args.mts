// Preserve the desktop's global flags and the vendor's subcommand precedence.
export function splitCodexGlobals(argv: string[]): { globals: string[]; rest: string[] } {
  const globals: string[] = []
  let index = 0
  while (index < argv.length) {
    const arg = argv[index] ?? ''
    if (/^(-c|--config|-m|--model|-p|--profile|-C|--cd)$/.test(arg)) {
      globals.push(arg, argv[index + 1] ?? '')
      index += 2
      continue
    }
    if (/^(-c|--config|-m|--model|--profile|--cd)=/.test(arg)) {
      globals.push(arg)
      index += 1
      continue
    }
    break
  }
  return { globals, rest: argv.slice(index) }
}

// ChatGPT 26.911 passes a subcommand -c; Codex then ignores root-level -c.
export function childArgv(globals: string[], extra: string[], rest: string[]): string[] {
  const subcommandHasConfig = rest.some(
    (arg) => arg === '-c' || arg === '--config' || /^(-c|--config)=/.test(arg),
  )
  return subcommandHasConfig ? [...globals, ...rest, ...extra] : [...globals, ...extra, ...rest]
}
