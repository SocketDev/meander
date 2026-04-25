/** @fileoverview Unit tests for envelope encryption: body encrypt/decrypt
 * with a per-row data key, plus wrapKey/unwrapKey for the data key under
 * a database wrapping key. */

import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'

import {
  decrypt,
  encrypt,
  packEnvelope,
  randomDataKey,
  randomWrappingKey,
  unpackEnvelope,
  unwrapKey,
  wrapKey,
} from '../src/crypto.mts'

describe('randomDataKey / randomWrappingKey', () => {
  it('returns 32-byte buffers', () => {
    expect(randomDataKey().length).toBe(32)
    expect(randomWrappingKey().length).toBe(32)
  })

  it('produces distinct keys per call', () => {
    const a = randomDataKey()
    const b = randomDataKey()
    expect(a.equals(b)).toBe(false)
  })
})

describe('encrypt / decrypt round-trip', () => {
  const key = randomDataKey()

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

  it('IV differs across encryptions of same plaintext', () => {
    const a = encrypt('same input', key)
    const b = encrypt('same input', key)
    expect(a).not.toBe(b)
    expect(decrypt(a, key)).toBe('same input')
    expect(decrypt(b, key)).toBe('same input')
  })

  it('rejects keys of wrong length', () => {
    const wrongKey = randomBytes(16)
    expect(() => encrypt('hi', wrongKey)).toThrow(/32 bytes/)
    expect(() => decrypt('AAAA', wrongKey)).toThrow(/32 bytes/)
  })
})

describe('decrypt rejects malformed input', () => {
  const key = randomDataKey()

  it('throws on too-short ciphertext', () => {
    expect(() => decrypt(Buffer.from('abc').toString('base64'), key)).toThrow(
      /too short/i,
    )
  })

  it('throws on wrong body version byte', () => {
    /* The body version is 0x10. A valid-shape buffer with a wrong
     * version byte must trip the version check before AES-GCM runs. */
    const buf = Buffer.alloc(1 + 12 + 16, 0)
    buf[0] = 0x99
    expect(() => decrypt(buf.toString('base64'), key)).toThrow(
      /unsupported body version/i,
    )
  })

  it('throws on wrong key', () => {
    const otherKey = randomDataKey()
    const ct = encrypt('secret', key)
    expect(() => decrypt(ct, otherKey)).toThrow()
  })

  it('throws on tampered ciphertext', () => {
    const ct = encrypt('integrity check', key)
    const bytes = Buffer.from(ct, 'base64')
    /* Flip a bit in the payload region (after version + IV).
     * AES-GCM's auth tag must reject. */
    bytes[bytes.length - 20]! ^= 0xff
    expect(() => decrypt(bytes.toString('base64'), key)).toThrow()
  })
})

describe('wrapKey / unwrapKey round-trip', () => {
  it('round-trips a data key under a wrapping key', () => {
    const dataKey = randomDataKey()
    const wrappingKey = randomWrappingKey()
    const wrapped = wrapKey(dataKey, wrappingKey)
    const unwrapped = unwrapKey(wrapped, wrappingKey)
    expect(unwrapped.equals(dataKey)).toBe(true)
  })

  it('produces a fixed-size wrapped form (61 bytes raw, base64)', () => {
    const dataKey = randomDataKey()
    const wrappingKey = randomWrappingKey()
    const wrapped = wrapKey(dataKey, wrappingKey)
    /* 1 (version) + 12 (IV) + 32 (ct) + 16 (tag) = 61 bytes raw,
     * which base64-encodes to 84 chars (with padding). */
    expect(Buffer.from(wrapped, 'base64').length).toBe(61)
    expect(wrapped.length).toBe(84)
  })

  it('IV differs across wraps of same data key', () => {
    const dataKey = randomDataKey()
    const wrappingKey = randomWrappingKey()
    const a = wrapKey(dataKey, wrappingKey)
    const b = wrapKey(dataKey, wrappingKey)
    expect(a).not.toBe(b)
    /* Both unwrap to the same data key. */
    expect(unwrapKey(a, wrappingKey).equals(dataKey)).toBe(true)
    expect(unwrapKey(b, wrappingKey).equals(dataKey)).toBe(true)
  })

  it('rotation pattern: rewrap under a new key without touching ciphertext', () => {
    /* This is the headline use case: rotate the wrapping key
     * without re-encrypting the body. The ciphertext stays
     * byte-identical; only the wrapped DEK changes. */
    const wrappingKey1 = randomWrappingKey()
    const wrappingKey2 = randomWrappingKey()
    const dataKey = randomDataKey()
    const wrapped1 = wrapKey(dataKey, wrappingKey1)
    const ciphertext = encrypt('comment body', dataKey)

    /* Rewrap: unwrap under old key, rewrap under new key. */
    const recovered = unwrapKey(wrapped1, wrappingKey1)
    const wrapped2 = wrapKey(recovered, wrappingKey2)

    /* Body decrypts identically with the recovered key. */
    expect(decrypt(ciphertext, recovered)).toBe('comment body')
    /* And with a fresh unwrap under the new wrapping key. */
    expect(decrypt(ciphertext, unwrapKey(wrapped2, wrappingKey2))).toBe(
      'comment body',
    )
  })
})

describe('packEnvelope / unpackEnvelope', () => {
  it('round-trips a wrapped blob through pack → unpack', () => {
    const wrappingKey = randomWrappingKey()
    const dataKey = randomDataKey()
    const ciphertext = encrypt('walkthrough HTML', dataKey)
    const wrappedDek = wrapKey(dataKey, wrappingKey)
    const blob = packEnvelope(ciphertext, wrappedDek)
    const parsed = unpackEnvelope(blob)
    if (!parsed) {
      throw new Error('unpackEnvelope returned undefined for envelope blob')
    }
    expect(parsed.ciphertext).toBe(ciphertext)
    expect(parsed.wrappedDek).toBe(wrappedDek)
    /* End-to-end: reader unwraps the DEK and decrypts the body. */
    const recovered = unwrapKey(parsed.wrappedDek, wrappingKey)
    expect(decrypt(parsed.ciphertext, recovered)).toBe('walkthrough HTML')
  })

  it('returns undefined for plaintext blobs (no envelope prefix)', () => {
    expect(unpackEnvelope('<html>hello</html>')).toBeUndefined()
    expect(unpackEnvelope('')).toBeUndefined()
    expect(unpackEnvelope('ENVE')).toBeUndefined()
  })

  it('throws on malformed envelope header', () => {
    expect(() => unpackEnvelope('ENVELOPE:wrong')).toThrow(/malformed/)
    expect(() => unpackEnvelope('ENVELOPE:2:a:b')).toThrow(/malformed/)
    expect(() => unpackEnvelope('ENVELOPE:1:onlytwo')).toThrow(/malformed/)
  })

  it('starts envelope with a recognizable prefix', () => {
    const blob = packEnvelope('ct', 'dek')
    expect(blob.startsWith('ENVELOPE:1:')).toBe(true)
  })
})

describe('unwrapKey rejects malformed input', () => {
  it('throws on wrong wrapped length', () => {
    const wrappingKey = randomWrappingKey()
    const tooShort = Buffer.alloc(50, 0).toString('base64')
    expect(() => unwrapKey(tooShort, wrappingKey)).toThrow(/length/)
  })

  it('throws on wrong wrap version byte', () => {
    const wrappingKey = randomWrappingKey()
    /* Build a buffer of correct length with a wrong version byte. */
    const buf = Buffer.alloc(1 + 12 + 32 + 16, 0)
    buf[0] = 0x99
    expect(() => unwrapKey(buf.toString('base64'), wrappingKey)).toThrow(
      /unsupported wrap version/i,
    )
  })

  it('throws on wrong wrapping key', () => {
    const dataKey = randomDataKey()
    const wrappingKey1 = randomWrappingKey()
    const wrappingKey2 = randomWrappingKey()
    const wrapped = wrapKey(dataKey, wrappingKey1)
    expect(() => unwrapKey(wrapped, wrappingKey2)).toThrow()
  })

  it('throws on wrapping-key wrong length', () => {
    const dataKey = randomDataKey()
    const shortKey = randomBytes(16)
    expect(() => wrapKey(dataKey, shortKey)).toThrow(/32 bytes/)
    expect(() =>
      unwrapKey('AAAA', shortKey),
    ).toThrow(/32 bytes/)
  })
})
