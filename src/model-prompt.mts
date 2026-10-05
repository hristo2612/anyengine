// Text supplied by another model is prose, never an operator's Claude command.
// Keep the command visible in the conversation, but out of slash dispatch.
export function modelPrompt(text: string): string {
  // Escape and control bytes must never close bracketed paste or type PTY keys.
  text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '')
  return /^\s*\//u.test(text) ? `Message from another model:\n${text}` : text
}

export function rehomePrompt(prefix: string, prompt: string): string {
  return modelPrompt(prompt ? `${prefix}\n\n${prompt}` : prefix)
}
