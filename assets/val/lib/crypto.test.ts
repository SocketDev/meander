/**
 * @fileoverview Tests for assets/val/lib/crypto.ts. Runs under
 * `node --test` (see package.json test:val). The helpers use
 * Web Crypto only, so the Node copy behaves identically to the
 * Deno runtime the val ships on.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { decrypt, deriveKey, encrypt } from './crypto.ts'

test('deriveKey: deterministic for the same password', async () => {
  const a = await deriveKey('round-trip')
  const b = await deriveKey('round-trip')
  /* Keys are non-extractable, so we round-trip through encrypt
   * to observe determinism — same key, same plaintext, two
   * identical decrypts. */
  const ct = await encrypt('hello', a)
  assert.equal(await decrypt(ct, b), 'hello')
})

test('deriveKey: different passwords produce incompatible keys', async () => {
  const a = await deriveKey('alpha')
  const b = await deriveKey('beta')
  const ct = await encrypt('secret', a)
  await assert.rejects(() => decrypt(ct, b))
})

test('encrypt/decrypt: round-trip ASCII', async () => {
  const key = await deriveKey('k1')
  const ct = await encrypt('hello world', key)
  assert.equal(await decrypt(ct, key), 'hello world')
})

test('encrypt/decrypt: round-trip unicode + multi-line', async () => {
  const key = await deriveKey('k2')
  const plain = 'héllo 世界 🦀\nline two\ttab'
  const ct = await encrypt(plain, key)
  assert.equal(await decrypt(ct, key), plain)
})

test('encrypt: produces base64 (no raw binary)', async () => {
  const key = await deriveKey('k3')
  const ct = await encrypt('abc', key)
  assert.match(ct, /^[A-Za-z0-9+/]+=*$/)
})

test('encrypt: unique IV per call (same input, different output)', async () => {
  const key = await deriveKey('k4')
  const a = await encrypt('same', key)
  const b = await encrypt('same', key)
  assert.notEqual(a, b)
  assert.equal(await decrypt(a, key), 'same')
  assert.equal(await decrypt(b, key), 'same')
})

test('decrypt: rejects short ciphertext', async () => {
  const key = await deriveKey('k5')
  await assert.rejects(
    () => decrypt(Buffer.from('abc').toString('base64'), key),
    /too short/i,
  )
})

test('decrypt: rejects unknown version byte', async () => {
  const key = await deriveKey('k6')
  const buf = new Uint8Array(1 + 12 + 16)
  buf[0] = 0x02
  const b64 = Buffer.from(buf).toString('base64')
  await assert.rejects(() => decrypt(b64, key), /unsupported encryption version/i)
})

test('decrypt: rejects tampered ciphertext (auth tag mismatch)', async () => {
  const key = await deriveKey('k7')
  const ct = await encrypt('integrity', key)
  const bytes = Buffer.from(ct, 'base64')
  /* Flip a bit in the auth-tag region. AES-GCM must reject. */
  bytes[bytes.length - 1] ^= 0xff
  await assert.rejects(() => decrypt(bytes.toString('base64'), key))
})
