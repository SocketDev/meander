/**
 * @fileoverview Unit tests for src/blob-key.mts internal helpers.
 *
 * Same shape as test/db-key.test.mts — the ceremony commands hit
 * Val Town's REST API and aren't isolatable without a mock server,
 * so we test the pure helpers here and trust integration to a
 * manual run against a live val.
 */

import { describe, expect, it } from 'vitest'

import { __test } from '../src/blob-key.mts'

const { bytesToHex, validateShamirParams } = __test

describe('blob-key bytesToHex', () => {
  it('zero-pads single-digit bytes', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 0xff]))).toBe('0001ff')
  })

  it('round-trips a 32-byte uniform random buffer', () => {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const hex = bytesToHex(bytes)
    expect(hex.length).toBe(64)
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('blob-key validateShamirParams', () => {
  it('accepts the default 2-of-3', () => {
    expect(() => validateShamirParams(2, 3)).not.toThrow()
  })

  it('rejects threshold < 2', () => {
    expect(() => validateShamirParams(1, 3)).toThrow(/threshold/)
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
})
