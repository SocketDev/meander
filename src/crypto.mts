import crypto from 'node:crypto'

/**
 * AES-256-GCM with envelope-key wrapping for the comment store.
 *
 * Two layers, with separate version bytes so the format is
 * self-describing:
 *
 * - Body encryption (encrypt/decrypt): a random per-row data key (DEK) encrypts
 *   the comment body + author. Version 0x10.
 * - Key wrapping (wrapKey/unwrapKey): the database wrapping key for some
 *   generation N encrypts the DEK. Version 0x20. The wrapped DEK is stored
 *   alongside the body ciphertext.
 *
 * This split is the standard envelope pattern: rotating the
 * wrapping key means re-wrapping each row's small DEK, not
 * re-encrypting comment bodies.
 *
 * Walkthrough HTML is *not* encrypted at rest — reader access is
 * gated by JWT auth, and the prose is the published artifact.
 *
 * Both layers use AES-256-GCM with a fresh random 96-bit IV. The
 * GCM auth tag means tampered ciphertext fails to decrypt — we
 * never silently return corrupted plaintext.
 */

const BODY_VERSION = 0x10
const WRAP_VERSION = 0x20

const KEY_BYTES = 32 // AES-256
const IV_BYTES = 12 // GCM standard
const TAG_BYTES = 16 // GCM standard

/**
 * Decrypt base64 ciphertext produced by encrypt(). Throws if the
 * auth tag fails — never returns mangled plaintext.
 */
export function decrypt(ciphertext: string, dataKey: Buffer): string {
  if (dataKey.length !== KEY_BYTES) {
    throw new Error(
      `decrypt: dataKey must be ${KEY_BYTES} bytes, got ${dataKey.length}`,
    )
  }
  const combined = Buffer.from(ciphertext, 'base64')
  if (combined.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('decrypt: ciphertext too short')
  }
  if (combined[0] !== BODY_VERSION) {
    throw new Error(
      `decrypt: unsupported body version 0x${combined[0]!.toString(16)}`,
    )
  }
  const iv = combined.subarray(1, 1 + IV_BYTES)
  const tag = combined.subarray(combined.length - TAG_BYTES)
  const ct = combined.subarray(1 + IV_BYTES, combined.length - TAG_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    'utf-8',
  )
}

/**
 * Encrypt plaintext with a 32-byte data key. Returns base64 of
 * [1 byte version 0x10][12 byte IV][ciphertext + 16 byte tag].
 */
export function encrypt(plaintext: string, dataKey: Buffer): string {
  if (dataKey.length !== KEY_BYTES) {
    throw new Error(
      `encrypt: dataKey must be ${KEY_BYTES} bytes, got ${dataKey.length}`,
    )
  }
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return Buffer.concat([
    Buffer.from([BODY_VERSION]),
    iv,
    ciphertext,
    tag,
  ]).toString('base64')
}

/**
 * Pack a freshly-encrypted blob payload into an envelope string.
 * Format: `ENVELOPE:1:<wrappedDEK base64>:<ciphertext base64>`.
 *
 * The version segment (`1`) is independent of the body/wrap version
 * bytes — it describes the *envelope wrapper format* itself, so a
 * future migration could change segment ordering without breaking
 * older readers' version checks. Blobs without the prefix are
 * treated as plaintext by readers, so this format is opt-in.
 */
export function packEnvelope(ciphertext: string, wrappedDek: string): string {
  return `ENVELOPE:1:${wrappedDek}:${ciphertext}`
}

/**
 * A fresh 32-byte data key suitable for use as a per-row DEK.
 */
export function randomDataKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES)
}

/**
 * A fresh 32-byte wrapping key suitable for use as a database-level KEK.
 */
export function randomWrappingKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES)
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
 * Unwrap a wrapped data key. Returns the raw 32-byte data key.
 * Throws if the auth tag fails (wrong wrapping key).
 */
export function unwrapKey(wrapped: string, wrappingKey: Buffer): Buffer {
  if (wrappingKey.length !== KEY_BYTES) {
    throw new Error(
      `unwrapKey: wrappingKey must be ${KEY_BYTES} bytes, got ${wrappingKey.length}`,
    )
  }
  const combined = Buffer.from(wrapped, 'base64')
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
  const iv = combined.subarray(1, 1 + IV_BYTES)
  const ct = combined.subarray(1 + IV_BYTES, 1 + IV_BYTES + KEY_BYTES)
  const tag = combined.subarray(1 + IV_BYTES + KEY_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/**
 * Wrap a 32-byte data key under a wrapping key. Returns base64 of
 * [1 byte version 0x20][12 byte IV][32 byte wrapped key + 16 byte tag].
 *
 * The wrapped form is exactly 61 bytes raw / 84 chars base64, so it
 * fits in any TEXT column without size concern.
 */
export function wrapKey(dataKey: Buffer, wrappingKey: Buffer): string {
  if (dataKey.length !== KEY_BYTES) {
    throw new Error(
      `wrapKey: dataKey must be ${KEY_BYTES} bytes, got ${dataKey.length}`,
    )
  }
  if (wrappingKey.length !== KEY_BYTES) {
    throw new Error(
      `wrapKey: wrappingKey must be ${KEY_BYTES} bytes, got ${wrappingKey.length}`,
    )
  }
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv)
  const ct = Buffer.concat([cipher.update(dataKey), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([WRAP_VERSION]), iv, ct, tag]).toString(
    'base64',
  )
}
