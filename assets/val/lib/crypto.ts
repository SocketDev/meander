/**
 * Crypto helpers shared between the Val Town runtime (Deno) and
 * Node tests. Web Crypto API is available in both, so these are
 * pure modules — no runtime-specific imports.
 *
 * AES-256-GCM at-rest encryption with a PBKDF2-derived key:
 *   binary layout = [1 byte version][12 byte IV][N byte ct+tag]
 *   transport     = base64 of the binary
 */

const VERSION_BYTE = 0x01
const SALT = new TextEncoder().encode('meander-walkthrough-v1')
const ITERATIONS = 600_000

export async function deriveKey(password: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encrypt(
  plaintext: string,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded,
  )
  const combined = new Uint8Array(1 + iv.length + ciphertext.byteLength)
  combined[0] = VERSION_BYTE
  combined.set(iv, 1)
  combined.set(new Uint8Array(ciphertext), 1 + iv.length)
  return btoa(String.fromCharCode(...combined))
}

export async function decrypt(
  ciphertext: string,
  key: CryptoKey,
): Promise<string> {
  const combined = new Uint8Array(
    atob(ciphertext)
      .split('')
      .map(c => c.charCodeAt(0)),
  )
  if (combined.length < 1 + 12 + 16) {
    throw new Error('Ciphertext too short')
  }
  if (combined[0] !== VERSION_BYTE) {
    throw new Error(`Unsupported encryption version: ${combined[0]}`)
  }
  const iv = combined.slice(1, 13)
  const data = combined.slice(13)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data,
  )
  return new TextDecoder().decode(plaintext)
}
