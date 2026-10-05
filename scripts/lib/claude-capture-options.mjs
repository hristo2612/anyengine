// Pure options parsing: importing this module cannot launch a capture or write a fixture.
export function parseClaudeMessagesArgs(args) {
  const options = {}
  for (let n = 0; n < args.length; n++) {
    const name = args[n]
    const value = args[++n]
    if (
      !['--claude', '--out'].includes(name) ||
      options[name] !== undefined ||
      typeof value !== 'string' ||
      !value ||
      value.startsWith('--') ||
      /[\0\r\n]/.test(value)
    )
      throw new Error('usage: capture-claude-messages.mjs --claude PATH [--out FILE]')
    options[name] = value
  }
  if (!options['--claude'])
    throw new Error('usage: capture-claude-messages.mjs --claude PATH [--out FILE]')
  return { binary: options['--claude'], out: options['--out'] ?? null }
}
