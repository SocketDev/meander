/**
 * @fileoverview Tests for assets/val/lib/auth.ts.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  emailDomainAllowed,
  hashCode,
  parseAllowedDomains,
  sixDigitCode,
} from './auth.ts'

test('parseAllowedDomains: empty → empty array', () => {
  assert.deepEqual(parseAllowedDomains(''), [])
  assert.deepEqual(parseAllowedDomains(undefined), [])
})

test('parseAllowedDomains: splits + trims + lowercases', () => {
  assert.deepEqual(
    parseAllowedDomains(' Gmail.com , Example.ORG,  socket.dev '),
    ['gmail.com', 'example.org', 'socket.dev'],
  )
})

test('parseAllowedDomains: drops empty segments', () => {
  assert.deepEqual(parseAllowedDomains('gmail.com,,,socket.dev,'), [
    'gmail.com',
    'socket.dev',
  ])
})

test('emailDomainAllowed: case-insensitive match', () => {
  const allowed = ['gmail.com', 'socket.dev']
  assert.equal(emailDomainAllowed('alice@Gmail.com', allowed), true)
  assert.equal(emailDomainAllowed('bob@GMAIL.COM', allowed), true)
})

test('emailDomainAllowed: rejects unknown domain', () => {
  assert.equal(emailDomainAllowed('eve@evil.com', ['gmail.com']), false)
})

test('emailDomainAllowed: rejects malformed input (no @)', () => {
  assert.equal(emailDomainAllowed('no-at-sign', ['gmail.com']), false)
})

test('emailDomainAllowed: empty allowlist refuses everything', () => {
  assert.equal(emailDomainAllowed('alice@gmail.com', []), false)
})

test('sixDigitCode: always 6 digits', () => {
  for (let i = 0; i < 100; i++) {
    const c = sixDigitCode()
    assert.equal(c.length, 6)
    assert.match(c, /^\d{6}$/)
  }
})

test('sixDigitCode: varies across calls', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 20; i++) {
    seen.add(sixDigitCode())
  }
  /* 20 draws from 1e6 should give well under 1% collision odds
   * — if we're seeing only 1 unique value, the RNG is broken. */
  assert.ok(seen.size > 10, `sixDigitCode not random enough: ${seen.size} unique`)
})

test('hashCode: deterministic for same (code, email)', async () => {
  const a = await hashCode('123456', 'alice@gmail.com')
  const b = await hashCode('123456', 'alice@gmail.com')
  assert.equal(a, b)
})

test('hashCode: different codes hash differently', async () => {
  const a = await hashCode('123456', 'alice@gmail.com')
  const b = await hashCode('654321', 'alice@gmail.com')
  assert.notEqual(a, b)
})

test('hashCode: same code, different emails hash differently (email = salt)', async () => {
  const a = await hashCode('123456', 'alice@gmail.com')
  const b = await hashCode('123456', 'bob@gmail.com')
  assert.notEqual(a, b)
})

test('hashCode: returns base64url (no +, /, =)', async () => {
  const h = await hashCode('123456', 'alice@gmail.com')
  assert.ok(!h.includes('+'))
  assert.ok(!h.includes('/'))
  assert.ok(!h.includes('='))
})
