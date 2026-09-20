const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function uid(prefix = ''): string {
  let out = ''
  const bytes = new Uint8Array(12)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return prefix ? `${prefix}_${out}` : out
}

export function now(): number {
  return Date.now()
}
