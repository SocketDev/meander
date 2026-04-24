import { randomBytes } from 'node:crypto'

/**
 * Shamir's Secret Sharing over GF(2^8).
 *
 * Splits a byte sequence into N shares such that any K can
 * reconstruct the original and any K-1 reveal nothing. Used
 * for custodial recovery of the database wrapping key.
 *
 * Algorithm: per byte of the secret, pick a random degree-(K-1)
 * polynomial whose constant term is the secret byte. Evaluate
 * at points 1..N to produce share bytes. Recovery is Lagrange
 * interpolation at x = 0.
 *
 * Constraints:
 *   - threshold >= 2 (threshold = 1 is plaintext)
 *   - threshold <= shares
 *   - shares <= 255 (x-coordinates are non-zero bytes)
 *
 * Share format: [0x01 version][1 byte threshold][1 byte x][N bytes y...]
 * The x-coordinate is also the share's "index" — combine() uses it
 * to interpolate. Encoded as base58 for printing.
 */

const VERSION = 0x01

/* GF(2^8) tables, AES-style: irreducible polynomial 0x11b. The exp
 * table indexes powers of the generator g = 0x03 (primitive root in
 * GF(2^8) under this polynomial); log is its inverse. Building once
 * at module load keeps multiply / divide constant-time table lookups. */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    /* Multiply by g = 0x03 in GF(2^8) under x^8 + x^4 + x^3 + x + 1.
     * 0x03 * x = (x << 1) ^ x; reduce mod 0x11b when bit 8 sets. */
    let next = (x << 1) ^ x
    if (next & 0x100) {
      next ^= 0x11b
    }
    x = next & 0xff
  }
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255]!
  }
  LOG[0] = 0 // unused; multiply guards on a==0 || b==0
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0
  }
  return EXP[LOG[a]! + LOG[b]!]!
}

function gfDiv(a: number, b: number): number {
  if (b === 0) {
    throw new Error('gfDiv: divide by zero')
  }
  if (a === 0) {
    return 0
  }
  return EXP[(LOG[a]! - LOG[b]! + 255) % 255]!
}

/** Evaluate polynomial coeffs at x in GF(2^8). Horner's method. */
function gfEval(coeffs: Uint8Array, x: number): number {
  let result = 0
  for (let i = coeffs.length - 1; i >= 0; i--) {
    result = gfMul(result, x) ^ coeffs[i]!
  }
  return result
}

/**
 * Split `secret` into `shares` shares with reconstruction
 * threshold `threshold`. Returns one Uint8Array per share, each
 * carrying the version + threshold header so combine() can
 * validate without external metadata.
 */
export function split(
  secret: Uint8Array,
  threshold: number,
  shares: number,
): Uint8Array[] {
  if (threshold < 2) {
    throw new Error('shamir.split: threshold must be >= 2')
  }
  if (shares < threshold) {
    throw new Error('shamir.split: shares must be >= threshold')
  }
  if (shares > 255) {
    throw new Error('shamir.split: shares must be <= 255 (GF(2^8) limit)')
  }
  if (secret.length === 0) {
    throw new Error('shamir.split: empty secret')
  }

  const out: Uint8Array[] = []
  for (let s = 1; s <= shares; s++) {
    /* 3-byte header: version, threshold, x. Body is `secret.length`
     * y-bytes, one per byte of the secret. */
    const buf = new Uint8Array(3 + secret.length)
    buf[0] = VERSION
    buf[1] = threshold
    buf[2] = s
    out.push(buf)
  }

  /* For each byte of the secret, build a fresh random polynomial
   * with that byte as the constant term, then evaluate at every
   * share's x-coordinate. Random coefficients come from the OS
   * CSPRNG — this is the line that makes Shamir actually secure. */
  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    const coeffs = new Uint8Array(threshold)
    coeffs[0] = secret[byteIdx]!
    const random = randomBytes(threshold - 1)
    for (let i = 1; i < threshold; i++) {
      coeffs[i] = random[i - 1]!
    }
    for (let s = 1; s <= shares; s++) {
      out[s - 1]![3 + byteIdx] = gfEval(coeffs, s)
    }
  }
  return out
}

/**
 * Reconstruct the secret from `>= threshold` distinct shares.
 * Throws if shares are malformed, mixed across thresholds, or
 * fewer than the threshold count.
 */
export function combine(shares: Uint8Array[]): Uint8Array {
  if (shares.length === 0) {
    throw new Error('shamir.combine: no shares')
  }
  /* Validate header consistency. All shares must carry the same
   * version + threshold and have matching length, and their
   * x-coordinates must be distinct + nonzero. */
  const first = shares[0]!
  if (first.length < 4) {
    throw new Error('shamir.combine: share too short')
  }
  if (first[0] !== VERSION) {
    throw new Error(`shamir.combine: unknown share version ${first[0]}`)
  }
  const threshold = first[1]!
  const bodyLen = first.length - 3
  const xs = new Set<number>()
  for (const s of shares) {
    if (s.length !== first.length) {
      throw new Error('shamir.combine: share length mismatch')
    }
    if (s[0] !== VERSION) {
      throw new Error('shamir.combine: share version mismatch')
    }
    if (s[1] !== threshold) {
      throw new Error('shamir.combine: share threshold mismatch')
    }
    if (s[2] === 0) {
      throw new Error('shamir.combine: share x-coordinate cannot be 0')
    }
    if (xs.has(s[2]!)) {
      throw new Error(`shamir.combine: duplicate share x=${s[2]}`)
    }
    xs.add(s[2]!)
  }
  if (shares.length < threshold) {
    throw new Error(
      `shamir.combine: need >= ${threshold} shares, got ${shares.length}`,
    )
  }

  /* Lagrange interpolation at x = 0. We only need the threshold
   * shares; extras are ignored (taking exactly `threshold` keeps
   * the math the same and the output identical). */
  const used = shares.slice(0, threshold)
  const out = new Uint8Array(bodyLen)
  for (let byteIdx = 0; byteIdx < bodyLen; byteIdx++) {
    let secretByte = 0
    for (let i = 0; i < used.length; i++) {
      const xi = used[i]![2]!
      const yi = used[i]![3 + byteIdx]!
      /* Lagrange basis: prod_{j != i} (0 - xj) / (xi - xj).
       * In GF(2^8) subtraction is XOR, so 0 - xj = xj. */
      let num = 1
      let den = 1
      for (let j = 0; j < used.length; j++) {
        if (i === j) {
          continue
        }
        const xj = used[j]![2]!
        num = gfMul(num, xj)
        den = gfMul(den, xi ^ xj)
      }
      secretByte ^= gfMul(yi, gfDiv(num, den))
    }
    out[byteIdx] = secretByte
  }
  return out
}

/**
 * Base58 (Bitcoin alphabet — no 0/O/I/l ambiguity) encoder.
 * Inline because we only need it for share I/O and a dep would
 * be 50× the size of this implementation.
 */
const B58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function encodeShare(share: Uint8Array): string {
  let n = 0n
  for (const b of share) {
    n = (n << 8n) | BigInt(b)
  }
  let out = ''
  while (n > 0n) {
    const r = Number(n % 58n)
    n = n / 58n
    out = B58_ALPHABET[r]! + out
  }
  /* Preserve leading zero bytes as leading '1's — base58 convention.
   * Without this, a share starting with 0x00 would lose a byte on
   * round-trip. Our shares start with the version byte (0x01) so
   * this never fires today, but it would silently break if the
   * format ever evolved. */
  for (const b of share) {
    if (b === 0) {
      out = '1' + out
    } else {
      break
    }
  }
  return out
}

export function decodeShare(encoded: string): Uint8Array {
  if (encoded.length === 0) {
    throw new Error('shamir.decodeShare: empty')
  }
  let n = 0n
  for (const ch of encoded) {
    const idx = B58_ALPHABET.indexOf(ch)
    if (idx < 0) {
      throw new Error(`shamir.decodeShare: invalid character '${ch}'`)
    }
    n = n * 58n + BigInt(idx)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  /* Restore leading zero bytes (mirror of encodeShare). */
  for (const ch of encoded) {
    if (ch === '1') {
      bytes.unshift(0)
    } else {
      break
    }
  }
  return new Uint8Array(bytes)
}
