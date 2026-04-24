/** @fileoverview Unit tests for AES-256-GCM encrypt/decrypt + PBKDF2 key derivation. */

import { describe, expect, it } from 'vitest'

import { decrypt, deriveKey, encrypt } from '../src/crypto.mts'

describe('deriveKey', () => {
  it('returns a 32-byte key', () => {
    const key = deriveKey('any-password')
    expect(key.length).toBe(32)
  })

  it('is deterministic — same password yields same key', () => {
    const a = deriveKey('password-123')
    const b = deriveKey('password-123')
    expect(a.equals(b)).toBe(true)
  })

  it('different passwords yield different keys', () => {
    const a = deriveKey('alpha')
    const b = deriveKey('beta')
    expect(a.equals(b)).toBe(false)
  })
})

describe('encrypt / decrypt round-trip', () => {
  const key = deriveKey('round-trip-password')

  it('round-trips ASCII text', () => {
    const ct = encrypt('hello world', key)
    expect(decrypt(ct, key)).toBe('hello world')
  })

  it('round-trips Unicode + emoji', () => {
    const plain = 'héllo 世界 🦀 \n\t'
    const ct = encrypt(plain, key)
    expect(decrypt(ct, key)).toBe(plain)
  })

  it('round-trips empty string', () => {
    const ct = encrypt('', key)
    expect(decrypt(ct, key)).toBe('')
  })

  it('round-trips large payload', () => {
    const plain = 'x'.repeat(100_000)
    const ct = encrypt(plain, key)
    expect(decrypt(ct, key)).toBe(plain)
  })

  it('output is base64 (no raw binary leakage)', () => {
    const ct = encrypt('abc', key)
    expect(ct).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })

  it('nonce/IV differs across encryptions of same plaintext', () => {
    const a = encrypt('same input', key)
    const b = encrypt('same input', key)
    expect(a).not.toBe(b)
    expect(decrypt(a, key)).toBe('same input')
    expect(decrypt(b, key)).toBe('same input')
  })
})

describe('decrypt rejects malformed input', () => {
  const key = deriveKey('decrypt-errors')

  it('throws on too-short ciphertext', () => {
    expect(() => decrypt(Buffer.from('abc').toString('base64'), key)).toThrow(
      /too short/i,
    )
  })

  it('throws on wrong version byte', () => {
    /* Craft a byte buffer with version 0x02 instead of 0x01 but
     * the minimum length so the short-circuit doesn't short-stop
     * us before the version check. */
    const buf = Buffer.alloc(1 + 12 + 16, 0)
    buf[0] = 0x02
    expect(() => decrypt(buf.toString('base64'), key)).toThrow(
      /unsupported encryption version/i,
    )
  })

  it('throws on wrong key', () => {
    const key2 = deriveKey('different')
    const ct = encrypt('secret', key)
    expect(() => decrypt(ct, key2)).toThrow()
  })

  it('throws on tampered ciphertext', () => {
    const ct = encrypt('integrity check', key)
    const bytes = Buffer.from(ct, 'base64')
    /* Flip a bit in the payload region (after version byte +
     * IV). AES-GCM's auth tag must reject. */
    bytes[bytes.length - 20]! ^= 0xff
    expect(() => decrypt(bytes.toString('base64'), key)).toThrow()
  })
})
