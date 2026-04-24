import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  split,
  combine,
  encodeShare,
  decodeShare,
} from '../src/shamir.mts'

const eq = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('shamir split/combine', () => {
  it('round-trips a 32-byte secret with 2-of-3', () => {
    const secret = randomBytes(32)
    const shares = split(secret, 2, 3)
    expect(shares).toHaveLength(3)
    /* Any 2 of 3 should reconstruct exactly. */
    expect(eq(combine([shares[0]!, shares[1]!]), secret)).toBe(true)
    expect(eq(combine([shares[0]!, shares[2]!]), secret)).toBe(true)
    expect(eq(combine([shares[1]!, shares[2]!]), secret)).toBe(true)
    /* All three also work — extras are tolerated. */
    expect(eq(combine(shares), secret)).toBe(true)
  })

  it('round-trips with 3-of-5', () => {
    const secret = randomBytes(32)
    const shares = split(secret, 3, 5)
    expect(shares).toHaveLength(5)
    /* Spot-check several 3-subsets. */
    expect(eq(combine([shares[0]!, shares[2]!, shares[4]!]), secret)).toBe(
      true,
    )
    expect(eq(combine([shares[1]!, shares[3]!, shares[4]!]), secret)).toBe(
      true,
    )
  })

  it('round-trips secrets of varied lengths', () => {
    for (const len of [1, 7, 16, 32, 64, 200]) {
      const secret = randomBytes(len)
      const shares = split(secret, 2, 3)
      expect(eq(combine([shares[0]!, shares[1]!]), secret)).toBe(true)
    }
  })

  it('threshold-1 shares reveal nothing about the secret', () => {
    /* This is the critical property: any K-1 shares must be
     * indistinguishable from random. We test it indirectly by
     * checking that combine() with K-1 shares throws (and that
     * the threshold check is actually what trips). A statistical
     * test for randomness is out of scope — the algorithm's
     * correctness around this is what GF(2^8) buys us. */
    const secret = randomBytes(32)
    const shares = split(secret, 3, 5)
    expect(() => combine([shares[0]!, shares[1]!])).toThrow(/need >= 3/)
  })

  it('rejects threshold < 2', () => {
    expect(() => split(new Uint8Array([1]), 1, 3)).toThrow(/threshold/)
    expect(() => split(new Uint8Array([1]), 0, 3)).toThrow(/threshold/)
  })

  it('rejects shares < threshold', () => {
    expect(() => split(new Uint8Array([1]), 3, 2)).toThrow(/shares/)
  })

  it('rejects shares > 255', () => {
    expect(() => split(new Uint8Array([1]), 2, 256)).toThrow(/255/)
  })

  it('rejects empty secret', () => {
    expect(() => split(new Uint8Array(0), 2, 3)).toThrow(/empty/)
  })

  it('rejects duplicate share x-coordinates', () => {
    const secret = randomBytes(8)
    const shares = split(secret, 2, 3)
    expect(() => combine([shares[0]!, shares[0]!])).toThrow(/duplicate/)
  })

  it('rejects mismatched share lengths', () => {
    const secret = randomBytes(8)
    const shares = split(secret, 2, 3)
    const truncated = shares[1]!.slice(0, -1)
    expect(() => combine([shares[0]!, truncated])).toThrow(/length mismatch/)
  })

  it('rejects mismatched thresholds', () => {
    const secret = randomBytes(8)
    const shares2 = split(secret, 2, 3)
    const shares3 = split(secret, 3, 5)
    expect(() =>
      combine([shares2[0]!, shares3[0]!]),
    ).toThrow(/length mismatch|threshold mismatch/)
  })

  it('rejects unknown version', () => {
    const secret = randomBytes(8)
    const shares = split(secret, 2, 3)
    const tampered = new Uint8Array(shares[0]!)
    tampered[0] = 0x99
    expect(() => combine([tampered, shares[1]!])).toThrow(/version/)
  })
})

describe('shamir encodeShare/decodeShare', () => {
  it('round-trips a share through base58', () => {
    const secret = randomBytes(32)
    const shares = split(secret, 2, 3)
    for (const s of shares) {
      const encoded = encodeShare(s)
      const decoded = decodeShare(encoded)
      expect(eq(decoded, s)).toBe(true)
    }
  })

  it('produces base58 output (no 0/O/I/l)', () => {
    const secret = randomBytes(32)
    const shares = split(secret, 2, 3)
    for (const s of shares) {
      const encoded = encodeShare(s)
      expect(encoded).not.toMatch(/[0OIl]/)
    }
  })

  it('rejects invalid characters', () => {
    expect(() => decodeShare('hello0world')).toThrow(/invalid character/)
  })

  it('rejects empty input', () => {
    expect(() => decodeShare('')).toThrow(/empty/)
  })

  it('round-trips under encode → decode → combine', () => {
    const secret = randomBytes(32)
    const shares = split(secret, 2, 3)
    const encoded = shares.map(encodeShare)
    const decoded = encoded.map(decodeShare)
    expect(eq(combine([decoded[0]!, decoded[1]!]), secret)).toBe(true)
  })
})

describe('shamir GF(2^8) sanity', () => {
  /* Indirect sanity: split + combine being inverses across many
   * random inputs is a strong end-to-end check on the field
   * arithmetic. If the multiplication/division tables were wrong,
   * combine() would return garbage, not the original secret. */
  it('round-trips 100 random secrets', () => {
    for (let i = 0; i < 100; i++) {
      const secret = randomBytes(32)
      const shares = split(secret, 2, 3)
      expect(eq(combine([shares[0]!, shares[2]!]), secret)).toBe(true)
    }
  })
})
