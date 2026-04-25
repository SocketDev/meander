/**
 * Crypto helpers shared between the Val Town runtime (Deno) and
 * Node tests. Web Crypto API is available in both, so these are
 * pure modules — no runtime-specific imports.
 *
 * AES-256-GCM with envelope-key wrapping for the comment store.
 *
 * Two layers, with separate version bytes so the format is
 * self-describing:
 *
 *   - Body encryption (encrypt/decrypt): a random per-row data
 *     key (DEK) encrypts the comment body + author. Version 0x10.
 *
 *   - Key wrapping (wrapKey/unwrapKey): the database wrapping key
 *     for some generation N encrypts the DEK. Version 0x20. The
 *     wrapped DEK is stored alongside the body ciphertext.
 *
 * This split is the standard envelope pattern: rotating the
 * wrapping key means re-wrapping each row's small DEK, not
 * re-encrypting comment bodies.
 *
 * Walkthrough HTML may also pass through encrypt/wrapKey when
 * the publisher opts in via `encryptBlobs: true` — see
 * packEnvelope/unpackEnvelope for the blob payload format.
 */

const BODY_VERSION = 0x10
const WRAP_VERSION = 0x20

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Import a 32-byte raw key as a non-extractable AES-GCM CryptoKey.
 * Both data keys and wrapping keys go through this helper —
 * they're indistinguishable at the AES level; only how callers
 * use them differs.
 */
export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `importKey: raw must be ${KEY_BYTES} bytes, got ${raw.length}`,
    )
  }
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** A fresh 32-byte data key suitable for use as a per-row DEK. */
export function randomDataKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES))
}

/**
 * Encrypt plaintext with an AES-GCM data key. Returns base64 of
 * [1 byte version 0x10][12 byte IV][ciphertext + 16 byte tag].
 */
export async function encrypt(
  plaintext: string,
  dataKey: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dataKey,
    encoded,
  )
  const combined = new Uint8Array(1 + iv.length + ciphertext.byteLength)
  combined[0] = BODY_VERSION
  combined.set(iv, 1)
  combined.set(new Uint8Array(ciphertext), 1 + iv.length)
  return base64Encode(combined)
}

/**
 * Decrypt base64 ciphertext produced by encrypt(). Throws if the
 * auth tag fails — never returns mangled plaintext.
 */
export async function decrypt(
  ciphertext: string,
  dataKey: CryptoKey,
): Promise<string> {
  const combined = base64Decode(ciphertext)
  if (combined.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('decrypt: ciphertext too short')
  }
  if (combined[0] !== BODY_VERSION) {
    throw new Error(
      `decrypt: unsupported body version 0x${combined[0]!.toString(16)}`,
    )
  }
  const iv = combined.slice(1, 1 + IV_BYTES)
  const data = combined.slice(1 + IV_BYTES)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    dataKey,
    data,
  )
  return new TextDecoder().decode(plaintext)
}

/**
 * Wrap a 32-byte raw data key under a wrapping key. Returns base64
 * of [1 byte version 0x20][12 byte IV][32 byte wrapped key + 16 byte tag].
 *
 * Caller passes the DEK as raw bytes (not a CryptoKey) because we
 * need to encrypt them as data — Web Crypto's AES-KW is more
 * restrictive about key sizes; AES-GCM with a fixed 32-byte
 * payload is portable + simpler to reason about.
 */
export async function wrapKey(
  rawDek: Uint8Array,
  wrappingKey: CryptoKey,
): Promise<string> {
  if (rawDek.length !== KEY_BYTES) {
    throw new Error(
      `wrapKey: rawDek must be ${KEY_BYTES} bytes, got ${rawDek.length}`,
    )
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    rawDek,
  )
  const combined = new Uint8Array(1 + iv.length + ciphertext.byteLength)
  combined[0] = WRAP_VERSION
  combined.set(iv, 1)
  combined.set(new Uint8Array(ciphertext), 1 + iv.length)
  return base64Encode(combined)
}

/**
 * Unwrap a wrapped data key. Returns the raw 32-byte data key.
 * Throws if the auth tag fails (wrong wrapping key).
 */
export async function unwrapKey(
  wrapped: string,
  wrappingKey: CryptoKey,
): Promise<Uint8Array> {
  const combined = base64Decode(wrapped)
  if (combined.length !== 1 + IV_BYTES + KEY_BYTES + TAG_BYTES) {
    throw new Error(
      `unwrapKey: wrapped key has wrong length (got ${combined.length}, expected ${1 + IV_BYTES + KEY_BYTES + TAG_BYTES})`,
    )
  }
  if (combined[0] !== WRAP_VERSION) {
    throw new Error(
      `unwrapKey: unsupported wrap version 0x${combined[0]!.toString(16)}`,
    )
  }
  const iv = combined.slice(1, 1 + IV_BYTES)
  const data = combined.slice(1 + IV_BYTES)
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    data,
  )
  return new Uint8Array(raw)
}

/**
 * Pack a freshly-encrypted blob payload into an envelope string.
 * Format: `ENVELOPE:1:<wrappedDEK base64>:<ciphertext base64>`.
 *
 * Mirrors src/crypto.mts on the Node side. The val recognizes the
 * prefix when serving blobs and decrypts before responding.
 */
export function packEnvelope(ciphertext: string, wrappedDek: string): string {
  return `ENVELOPE:1:${wrappedDek}:${ciphertext}`
}

/**
 * Recognize and parse an envelope-wrapped blob. Returns undefined
 * if the input lacks the prefix (caller treats as plaintext).
 * Throws if the prefix is present but malformed.
 */
export function unpackEnvelope(
  blob: string,
): { wrappedDek: string; ciphertext: string } | undefined {
  if (!blob.startsWith('ENVELOPE:')) {
    return undefined
  }
  const parts = blob.split(':')
  if (parts.length !== 4 || parts[1] !== '1') {
    throw new Error('unpackEnvelope: malformed envelope header')
  }
  return { wrappedDek: parts[2]!, ciphertext: parts[3]! }
}

/**
 * Decode a 64-char hex string into a 32-byte key. Both env-loaded
 * wrapping keys (`MEANDER_BLOB_KEY`, `MEANDER_DB_KEY_<n>`) arrive
 * as hex so they're easy to print, paste, and store.
 */
export function decodeHexKey(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('decodeHexKey: must be 64 hex characters (32 bytes)')
  }
  const out = new Uint8Array(KEY_BYTES)
  for (let i = 0; i < KEY_BYTES; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/* Base64 helpers that don't blow the stack on large payloads.
 * `btoa(String.fromCharCode(...arr))` apply-spreads the array,
 * which hits the engine's argument-count limit somewhere around
 * 100KB. Walkthrough HTML can be larger than that. */
function base64Encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]!)
  }
  return btoa(s)
}

function base64Decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}
