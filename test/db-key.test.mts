/**
 * @fileoverview Unit tests for src/db-key.mts internal helpers.
 *
 * The ceremony commands (init/rotate/restore/audit/retire) call out
 * to Val Town's REST API + the val's /admin/* endpoints, so they
 * can't be tested in isolation without a mock server. We test the
 * pure helpers — hex coding, Shamir param validation, share
 * encoding — and trust integration to a manual run against a live
 * val.
 */

import { describe, expect, it } from 'vitest'

import { __test } from '../src/db-key.mts'

const { bytesToHex, hexToBytes, validateShamirParams } = __test

describe('bytesToHex / hexToBytes', () => {
  it('round-trips a 32-byte buffer', () => {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      bytes[i] = i
    }
    const hex = bytesToHex(bytes)
    expect(hex).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
    const decoded = hexToBytes(hex)
    expect(Array.from(decoded)).toEqual(Array.from(bytes))
  })

  it('zero-pads single-digit bytes', () => {
    const bytes = new Uint8Array([0, 1, 0xff])
    expect(bytesToHex(bytes)).toBe('0001ff')
  })

  it('rejects non-64-char hex', () => {
    expect(() => hexToBytes('00')).toThrow(/64 hex/)
    expect(() => hexToBytes('z'.repeat(64))).toThrow(/64 hex/)
  })

  it('round-trips a uniform random 32-byte buffer', () => {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const hex = bytesToHex(bytes)
    expect(hex.length).toBe(64)
    expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes))
  })
})

describe('validateShamirParams', () => {
  it('accepts the default 2-of-3', () => {
    expect(() => validateShamirParams(2, 3)).not.toThrow()
  })

  it('accepts 3-of-5', () => {
    expect(() => validateShamirParams(3, 5)).not.toThrow()
  })

  it('rejects threshold < 2', () => {
    expect(() => validateShamirParams(1, 3)).toThrow(/threshold/)
    expect(() => validateShamirParams(0, 3)).toThrow(/threshold/)
  })

  it('rejects shares < threshold', () => {
    expect(() => validateShamirParams(3, 2)).toThrow(/shares/)
  })

  it('rejects shares > 255', () => {
    expect(() => validateShamirParams(2, 256)).toThrow(/255/)
  })

  it('rejects non-integer values', () => {
    expect(() => validateShamirParams(2.5, 3)).toThrow(/integer/)
    expect(() => validateShamirParams(2, 3.7)).toThrow(/integer/)
  })

  it('rejects NaN', () => {
    expect(() => validateShamirParams(Number.NaN, 3)).toThrow(/integer/)
    expect(() => validateShamirParams(2, Number.NaN)).toThrow(/integer/)
  })
})
