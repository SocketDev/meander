/**
 * @file Tests for assets/val/lib/crypto.ts. Runs under
 *   `node --test` (see package.json test:val). The helpers use
 *   Web Crypto only, so the Node copy behaves identically to the
 *   Deno runtime the val ships on.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  decodeHexKey,
  decrypt,
  encrypt,
  importKey,
  packEnvelope,
  randomDataKeyBytes,
  unpackEnvelope,
  unwrapKey,
  wrapKey,
} from './crypto.ts'

export function FRESH_BYTES() {
  return randomDataKeyBytes()
}

test('importKey: rejects wrong size', async () => {
  await assert.rejects(() => importKey(new Uint8Array(16)), /32 bytes/)
})

test('randomDataKeyBytes: returns 32 bytes', () => {
  const k = randomDataKeyBytes()
  assert.equal(k.length, 32)
})

test('randomDataKeyBytes: produces distinct keys per call', () => {
  const a = randomDataKeyBytes()
  const b = randomDataKeyBytes()
  assert.notEqual(
    Buffer.from(a).toString('hex'),
    Buffer.from(b).toString('hex'),
  )
})

test('encrypt/decrypt: round-trip ASCII', async () => {
  const key = await importKey(FRESH_BYTES())
  const ct = await encrypt('hello world', key)
  assert.equal(await decrypt(ct, key), 'hello world')
})

test('encrypt/decrypt: round-trip unicode + multi-line', async () => {
  const key = await importKey(FRESH_BYTES())
  const plain = 'héllo 世界 🦀\nline two\ttab'
  const ct = await encrypt(plain, key)
  assert.equal(await decrypt(ct, key), plain)
})

test('encrypt/decrypt: round-trip large payload (>100KB)', async () => {
  /* Walkthrough HTML can exceed the spread-arg limit that broke
   * the previous base64 helper. This is the regression guard. */
  const key = await importKey(FRESH_BYTES())
  const plain = 'x'.repeat(150_000)
  const ct = await encrypt(plain, key)
  assert.equal(await decrypt(ct, key), plain)
})

test('encrypt: produces base64 (no raw binary)', async () => {
  const key = await importKey(FRESH_BYTES())
  const ct = await encrypt('abc', key)
  assert.match(ct, /^[A-Za-z0-9+/]+=*$/)
})

test('encrypt: unique IV per call (same input, different output)', async () => {
  const key = await importKey(FRESH_BYTES())
  const a = await encrypt('same', key)
  const b = await encrypt('same', key)
  assert.notEqual(a, b)
  assert.equal(await decrypt(a, key), 'same')
  assert.equal(await decrypt(b, key), 'same')
})

test('decrypt: rejects short ciphertext', async () => {
  const key = await importKey(FRESH_BYTES())
  await assert.rejects(
    () => decrypt(Buffer.from('abc').toString('base64'), key),
    /too short/i,
  )
})

test('decrypt: rejects unknown body version byte', async () => {
  const key = await importKey(FRESH_BYTES())
  const buf = new Uint8Array(1 + 12 + 16)
  buf[0] = 0x99
  const b64 = Buffer.from(buf).toString('base64')
  await assert.rejects(() => decrypt(b64, key), /unsupported body version/i)
})

test('decrypt: rejects wrong key (auth tag mismatch)', async () => {
  const a = await importKey(FRESH_BYTES())
  const b = await importKey(FRESH_BYTES())
  const ct = await encrypt('secret', a)
  await assert.rejects(() => decrypt(ct, b))
})

test('decrypt: rejects tampered ciphertext (auth tag mismatch)', async () => {
  const key = await importKey(FRESH_BYTES())
  const ct = await encrypt('integrity', key)
  const bytes = Buffer.from(ct, 'base64')
  bytes[bytes.length - 1] ^= 0xff
  await assert.rejects(() => decrypt(bytes.toString('base64'), key))
})

test('wrapKey/unwrapKey: round-trips a DEK under a wrapping key', async () => {
  const dek = randomDataKeyBytes()
  const wrapping = await importKey(FRESH_BYTES())
  const wrapped = await wrapKey(dek, wrapping)
  const unwrapped = await unwrapKey(wrapped, wrapping)
  assert.equal(
    Buffer.from(unwrapped).toString('hex'),
    Buffer.from(dek).toString('hex'),
  )
})

test('wrapKey/unwrapKey: rejects wrong wrapping key (auth tag mismatch)', async () => {
  const dek = randomDataKeyBytes()
  const a = await importKey(FRESH_BYTES())
  const b = await importKey(FRESH_BYTES())
  const wrapped = await wrapKey(dek, a)
  await assert.rejects(() => unwrapKey(wrapped, b))
})

test('wrapKey: rejects DEK of wrong size', async () => {
  const wrapping = await importKey(FRESH_BYTES())
  await assert.rejects(() => wrapKey(new Uint8Array(16), wrapping), /32 bytes/)
})

test('unwrapKey: rejects malformed wrapped length', async () => {
  const wrapping = await importKey(FRESH_BYTES())
  const tooShort = Buffer.alloc(50, 0).toString('base64')
  await assert.rejects(() => unwrapKey(tooShort, wrapping), /length/)
})

test('unwrapKey: rejects unknown wrap version byte', async () => {
  const wrapping = await importKey(FRESH_BYTES())
  const buf = new Uint8Array(1 + 12 + 32 + 16)
  buf[0] = 0x99
  await assert.rejects(
    () => unwrapKey(Buffer.from(buf).toString('base64'), wrapping),
    /unsupported wrap version/i,
  )
})

test('rotation pattern: rewrap DEK under a new wrapping key, ciphertext untouched', async () => {
  const wrapping1 = await importKey(FRESH_BYTES())
  const wrapping2 = await importKey(FRESH_BYTES())
  const dekBytes = randomDataKeyBytes()
  const dekImported = await importKey(dekBytes)
  const ciphertext = await encrypt('comment body', dekImported)
  const wrapped1 = await wrapKey(dekBytes, wrapping1)

  /* Rewrap: unwrap under old key, rewrap under new key. */
  const recovered = await unwrapKey(wrapped1, wrapping1)
  const wrapped2 = await wrapKey(recovered, wrapping2)

  /* Body decrypts identically with the recovered key (same bytes). */
  const recoveredCryptoKey = await importKey(recovered)
  assert.equal(await decrypt(ciphertext, recoveredCryptoKey), 'comment body')

  /* And via fresh unwrap under the new wrapping key. */
  const reUnwrapped = await unwrapKey(wrapped2, wrapping2)
  const reCryptoKey = await importKey(reUnwrapped)
  assert.equal(await decrypt(ciphertext, reCryptoKey), 'comment body')
})

test('packEnvelope/unpackEnvelope: round-trips a wrapped blob', async () => {
  const wrapping = await importKey(FRESH_BYTES())
  const dekBytes = randomDataKeyBytes()
  const dekImported = await importKey(dekBytes)
  const ct = await encrypt('walkthrough HTML', dekImported)
  const wrappedDek = await wrapKey(dekBytes, wrapping)
  const blob = packEnvelope(ct, wrappedDek)
  const parsed = unpackEnvelope(blob)
  assert.ok(parsed)
  assert.equal(parsed!.ciphertext, ct)
  assert.equal(parsed!.wrappedDek, wrappedDek)
  /* End-to-end: reader unwraps the DEK and decrypts the body. */
  const recoveredDek = await unwrapKey(parsed!.wrappedDek, wrapping)
  const recoveredCrypto = await importKey(recoveredDek)
  assert.equal(
    await decrypt(parsed!.ciphertext, recoveredCrypto),
    'walkthrough HTML',
  )
})

test('unpackEnvelope: returns undefined for plaintext blobs (no prefix)', () => {
  assert.equal(unpackEnvelope('<html>hello</html>'), undefined)
  assert.equal(unpackEnvelope(''), undefined)
  assert.equal(unpackEnvelope('ENVE'), undefined)
})

test('unpackEnvelope: throws on malformed envelope header', () => {
  assert.throws(() => unpackEnvelope('ENVELOPE:wrong'), /malformed/)
  assert.throws(() => unpackEnvelope('ENVELOPE:2:a:b'), /malformed/)
  assert.throws(() => unpackEnvelope('ENVELOPE:1:onlytwo'), /malformed/)
})

test('decodeHexKey: parses 64-char hex into 32 bytes', () => {
  const hex = '00'.repeat(32)
  const bytes = decodeHexKey(hex)
  assert.equal(bytes.length, 32)
  assert.equal(
    Buffer.from(bytes).every(b => b === 0),
    true,
  )
})

test('decodeHexKey: rejects wrong length', () => {
  assert.throws(() => decodeHexKey('00'.repeat(16)), /64 hex/)
})

test('decodeHexKey: rejects non-hex characters', () => {
  assert.throws(() => decodeHexKey('z'.repeat(64)), /64 hex/)
})

test('decodeHexKey: round-trips through importKey + encrypt + decrypt', async () => {
  const hex = Buffer.from(randomDataKeyBytes()).toString('hex')
  const key = await importKey(decodeHexKey(hex))
  const ct = await encrypt('round trip', key)
  assert.equal(await decrypt(ct, key), 'round trip')
})
