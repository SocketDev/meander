/**
 * @file Tests for assets/val/lib/jwt.ts.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { b64urlDecode, b64urlEncode, signJwt, verifyJwt } from './jwt.ts'

const SECRET = 'x'.repeat(32)

test('b64url: round-trip arbitrary bytes', () => {
  const input = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255])
  assert.deepEqual(
    Array.from(b64urlDecode(b64urlEncode(input))),
    Array.from(input),
  )
})

test('b64url: no +, /, or = in output', () => {
  const encoded = b64urlEncode(new Uint8Array([255, 255, 255]))
  assert.ok(!encoded.includes('+'))
  assert.ok(!encoded.includes('/'))
  assert.ok(!encoded.includes('='))
})

test('signJwt/verifyJwt: round-trip a simple payload', async () => {
  const now = Math.floor(Date.now() / 1000)
  const token = await signJwt(
    { email: 'alice@example.com', exp: now + 60 },
    SECRET,
  )
  const payload = await verifyJwt(token, SECRET, now)
  assert.ok(payload)
  assert.equal(payload['email'], 'alice@example.com')
})

test('verifyJwt: rejects bad signature', async () => {
  const now = Math.floor(Date.now() / 1000)
  const token = await signJwt(
    { email: 'alice@example.com', exp: now + 60 },
    SECRET,
  )
  const payload = await verifyJwt(
    token,
    'different-secret-of-equal-length',
    now,
  )
  assert.equal(payload, undefined)
})

test('verifyJwt: rejects expired token (exp < now)', async () => {
  const now = Math.floor(Date.now() / 1000)
  const token = await signJwt(
    { email: 'alice@example.com', exp: now - 1 },
    SECRET,
  )
  assert.equal(await verifyJwt(token, SECRET, now), undefined)
})

test('verifyJwt: accepts token with no exp claim (non-expiring)', async () => {
  const token = await signJwt({ email: 'svc-account' }, SECRET)
  const payload = await verifyJwt(token, SECRET)
  assert.ok(payload)
  assert.equal(payload['email'], 'svc-account')
})

test('verifyJwt: rejects malformed token (wrong segment count)', async () => {
  assert.equal(await verifyJwt('not.enough', SECRET), undefined)
  assert.equal(await verifyJwt('way.too.many.parts.here', SECRET), undefined)
})

test('verifyJwt: rejects non-JSON body', async () => {
  /* Craft header.body.sig where body isn't valid JSON but the
   * signature matches — tests the JSON.parse catch. */
  const head = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  )
  const body = b64urlEncode(new TextEncoder().encode('not-json'))
  const keyBytes = new TextEncoder().encode(SECRET)
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${head}.${body}`),
  )
  const token = `${head}.${body}.${b64urlEncode(new Uint8Array(sig))}`
  assert.equal(await verifyJwt(token, SECRET), undefined)
})
