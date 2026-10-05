// MIT port of raine v0.1.42 reasoning_signature.rs; see vendored provenance.
import { TextDecoder } from 'node:util'

const PREFIX = 'ccp:codex:v1:'
const MAX_ID = 4 * 1024
const MAX_ENCRYPTED = 8 * 1024 * 1024
const MAX_ENCODED_ID = Math.ceil(MAX_ID / 3) * 4
const decoder = new TextDecoder('utf-8', { fatal: true })

export function encodeReasoning(id: string, encrypted: string): string | null {
  if (
    !id ||
    !encrypted ||
    Buffer.byteLength(id) > MAX_ID ||
    Buffer.byteLength(encrypted) > MAX_ENCRYPTED
  )
    return null
  const bytes = Buffer.from(id)
  if (decoder.decode(bytes) !== id) return null
  return `${PREFIX}${bytes.toString('base64url')}:${encrypted}`
}

export function decodeReasoning(
  signature: string,
): { id: string; encrypted_content: string } | null {
  if (
    !signature.startsWith(PREFIX) ||
    signature.length > PREFIX.length + MAX_ENCODED_ID + 1 + MAX_ENCRYPTED
  )
    return null
  const payload = signature.slice(PREFIX.length),
    separator = payload.indexOf(':')
  if (separator < 1 || separator > MAX_ENCODED_ID) return null
  const encoded = payload.slice(0, separator),
    encrypted = payload.slice(separator + 1)
  if (
    !encrypted ||
    Buffer.byteLength(encrypted) > MAX_ENCRYPTED ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    encoded.length % 4 === 1
  )
    return null
  const bytes = Buffer.from(encoded, 'base64url')
  if (!bytes.length || bytes.length > MAX_ID || bytes.toString('base64url') !== encoded) return null
  try {
    return { id: decoder.decode(bytes), encrypted_content: encrypted }
  } catch {
    return null
  }
}
