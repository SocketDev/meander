/**
 * @file Property/fuzz tests for src/shamir (Tier-1 fast-check).
 *   Shamir Secret Sharing over GF(2^8). The load-bearing contracts:
 *
 *   - ROUND-TRIP: `combine` of ANY `>= threshold` distinct shares produced by
 *     `split(secret, threshold, shares)` reconstructs `secret` exactly, in any
 *     order, ignoring extras.
 *   - ROUND-TRIP: `decodeShare(encodeShare(bytes)) === bytes` (base58 codec,
 *     leading-zero preserving).
 *   - FIELD LAWS: `gfMul` is commutative with 0/1 as annihilator/identity, and
 *     `gfDiv` inverts `gfMul`.
 *   - VALIDATION: `split` / `combine` reject malformed parameters with an Error
 *     rather than crashing or returning garbage. Every arbitrary is CONSTRUCTED
 *     so the expected outcome is known without reimplementing the field math.
 */

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  combine,
  decodeShare,
  encodeShare,
  gfDiv,
  gfEval,
  gfMul,
  split,
} from '../src/shamir.mts'

// Bitcoin base58 alphabet — used only to CONSTRUCT valid encoded input for the
// decoder's never-throws property, not to predict any SUT output.
const B58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const byte = fc.integer({ min: 0, max: 255 })
const nonZeroByte = fc.integer({ min: 1, max: 255 })

// A secret + a (threshold, shares) pair with threshold in [2, shares], plus a
// shuffled subset of distinct share indices of size >= threshold. Built with
// .chain so the subset can depend on the generated share count.
const shareScenario = fc
  .record({
    secret: fc.uint8Array({ minLength: 1, maxLength: 24 }),
    threshold: fc.integer({ min: 2, max: 5 }),
    extra: fc.integer({ min: 0, max: 5 }),
  })
  .chain(({ extra, secret, threshold }) => {
    const sharesCount = threshold + extra
    const allIndices = [...Array(sharesCount).keys()]
    return fc.record({
      secret: fc.constant(secret),
      threshold: fc.constant(threshold),
      sharesCount: fc.constant(sharesCount),
      subset: fc.shuffledSubarray(allIndices, {
        minLength: threshold,
        maxLength: sharesCount,
      }),
    })
  })

describe('shamir — fuzz', () => {
  // ROUND-TRIP (classical #4): any >= threshold distinct shares reconstruct the
  // exact secret, regardless of order or extras.
  test('combine(subset of split(...)) recovers the secret', () => {
    fc.assert(
      fc.property(
        shareScenario,
        ({ secret, sharesCount, subset, threshold }) => {
          const shares = split(secret, threshold, sharesCount)
          const picked = subset.map(i => shares[i])
          const recovered = combine(picked)
          expect([...recovered]).toEqual([...secret])
        },
      ),
    )
  })

  // INVARIANT: split produces exactly `shares` well-formed shares — version
  // byte 0x01, threshold byte, distinct 1-based x-coordinates, body length
  // equal to the secret length.
  test('split emits well-formed, distinctly-indexed shares', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 24 }),
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 0, max: 8 }),
        (secret, threshold, extra) => {
          const sharesCount = threshold + extra
          const shares = split(secret, threshold, sharesCount)
          expect(shares.length).toBe(sharesCount)
          const seenX = new Set<number>()
          for (let i = 0; i < shares.length; i += 1) {
            const s = shares[i]
            expect(s.length).toBe(3 + secret.length)
            expect(s[0]).toBe(0x01)
            expect(s[1]).toBe(threshold)
            expect(s[2]).toBe(i + 1)
            seenX.add(s[2])
          }
          expect(seenX.size).toBe(sharesCount)
        },
      ),
    )
  })

  // ROUND-TRIP (classical #4): the base58 codec is loss-less on any non-empty
  // byte sequence, including leading zero bytes.
  test('decodeShare(encodeShare(bytes)) === bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 40 }), bytes => {
        const roundTripped = decodeShare(encodeShare(bytes))
        expect([...roundTripped]).toEqual([...bytes])
      }),
    )
  })

  // NEVER-THROWS (parser robustness): on any base58-alphabet string the decoder
  // returns a Uint8Array rather than crashing.
  test('decodeShare never throws on base58-alphabet input', () => {
    const b58String = fc
      .array(fc.constantFrom(...B58_ALPHABET.split('')), {
        minLength: 1,
        maxLength: 40,
      })
      .map(chars => chars.join(''))
    fc.assert(
      fc.property(b58String, s => {
        expect(decodeShare(s)).toBeInstanceOf(Uint8Array)
      }),
    )
  })

  // INVARIANT: gfMul is commutative, 0 annihilates, 1 is the identity.
  test('gfMul is commutative with 0-annihilator and 1-identity', () => {
    fc.assert(
      fc.property(byte, byte, (a, b) => {
        // Self-comparison: compute both orderings in vars so neither `gfMul`
        // call sits inside `expect(...)` building the expected side.
        const ab = gfMul(a, b)
        const ba = gfMul(b, a)
        expect(ab).toBe(ba)
        expect(gfMul(a, 0)).toBe(0)
        expect(gfMul(0, a)).toBe(0)
        expect(gfMul(a, 1)).toBe(a)
      }),
    )
  })

  // ROUND-TRIP: division inverts multiplication for any non-zero divisor.
  test('gfDiv(gfMul(a, b), b) === a for b != 0', () => {
    fc.assert(
      fc.property(byte, nonZeroByte, (a, b) => {
        // Build the product in a var; `gfDiv` (the SUT here) is the only src
        // call left inside `expect(...)`.
        const product = gfMul(a, b)
        expect(gfDiv(product, b)).toBe(a)
      }),
    )
  })

  // INVARIANT: evaluating a polynomial at x = 0 yields its constant term.
  test('gfEval(coeffs, 0) === coeffs[0]', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 12 }), coeffs => {
        expect(gfEval(coeffs, 0)).toBe(coeffs[0])
      }),
    )
  })

  // VALIDATION: split rejects out-of-contract parameters instead of returning
  // garbage. Each malformed case is constructed to violate exactly one rule.
  test('split rejects malformed parameters', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 8 }),
        fc.integer({ min: 2, max: 8 }),
        (secret, threshold) => {
          // threshold < 2
          expect(() => split(secret, 1, 3)).toThrow()
          // shares < threshold
          expect(() => split(secret, threshold, threshold - 1)).toThrow()
          // shares > 255
          expect(() => split(secret, threshold, 256)).toThrow()
          // empty secret
          expect(() => split(new Uint8Array(0), threshold, threshold)).toThrow()
        },
      ),
    )
  })

  // VALIDATION: combine rejects an under-sized share set. Fewer than `threshold`
  // shares must throw rather than silently returning a wrong secret.
  test('combine throws when given fewer than threshold shares', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 12 }),
        fc.integer({ min: 3, max: 6 }),
        (secret, threshold) => {
          const shares = split(secret, threshold, threshold)
          expect(() => combine(shares.slice(0, threshold - 1))).toThrow()
          expect(() => combine([])).toThrow()
        },
      ),
    )
  })
})
