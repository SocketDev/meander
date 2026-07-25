/**
 * @file Property/fuzz tests for src/classifiers (Tier-1 fast-check).
 *   The four predicates (`isEmail`, `isPurl`, `isScopedPackage`, `isUrl`) are
 *   shape-only regex classifiers over untrusted annotation text. Contracts:
 *
 *   - NEVER-THROWS: every predicate returns a boolean for ANY string (no crash,
 *     no ReDoS-induced hang within the run budget).
 *   - CONSTRUCTED-VALID: strings assembled to match a kind's documented shape are
 *     classified true.
 *   - RESTRICTED-INPUT: strings assembled to miss a kind's structural anchor (the
 *     `@`, the `pkg:` prefix, the `://`) are classified false. Valid/invalid
 *     inputs are CONSTRUCTED from character alphabets so the expected verdict
 *     is known up front — no regex is reimplemented to predict.
 */

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { isEmail, isPurl, isScopedPackage, isUrl } from '../src/classifiers.mts'

// Simple, meta-free alphabets so every constructed value's verdict is obvious.
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
const PKG_TAIL = 'abcdefghijklmnopqrstuvwxyz0123456789._-'

function fromChars(alphabet: string, minLength: number, maxLength: number) {
  return fc
    .array(fc.constantFrom(...alphabet.split('')), { minLength, maxLength })
    .map(chars => chars.join(''))
}

// `@scope/name` — each segment starts alnum then allows [a-z0-9._-].
const scopedPackage = fc
  .tuple(
    fc.constantFrom(...ALNUM.split('')),
    fromChars(PKG_TAIL, 0, 12),
    fc.constantFrom(...ALNUM.split('')),
    fromChars(PKG_TAIL, 0, 12),
  )
  .map(([s0, sRest, n0, nRest]) => `@${s0}${sRest}/${n0}${nRest}`)

// A minimal-to-rich purl: `pkg:type(/seg)+` with optional @version.
const purl = fc
  .record({
    type: fc
      .tuple(fc.constantFrom(...LOWER.split('')), fromChars(ALNUM, 0, 8))
      .map(([h, t]) => `${h}${t}`),
    segments: fc.array(fromChars(ALNUM, 1, 10), { minLength: 1, maxLength: 3 }),
    version: fc.option(fromChars(ALNUM, 1, 8), { nil: undefined }),
  })
  .map(({ segments, type, version }) => {
    const base = `pkg:${type}/${segments.join('/')}`
    return version === undefined ? base : `${base}@${version}`
  })

// `local@label.tld` where the TLD is 2+ letters (the guard that keeps version
// strings like `core@7.0.0` OUT of the email bucket).
const email = fc
  .tuple(
    fromChars(ALNUM, 1, 12),
    fromChars(ALNUM, 1, 12),
    fromChars(LOWER, 2, 6),
  )
  .map(([local, label, tld]) => `${local}@${label}.${tld}`)

// `scheme://rest` with a non-space, quote-free authority/path.
const url = fc
  .tuple(
    fc
      .tuple(
        fc.constantFrom(...LOWER.split('')),
        fromChars(`${ALNUM}+.-`, 0, 6),
      )
      .map(([h, t]) => `${h}${t}`),
    fromChars(`${ALNUM}/.-`, 1, 20),
  )
  .map(([scheme, rest]) => `${scheme}://${rest}`)

// A bare word with no structural anchors — no `@`, `/`, `:`, or `.`.
const bareWord = fromChars(LOWER, 1, 16)

describe('classifiers — fuzz', () => {
  // NEVER-THROWS: every predicate is total over arbitrary strings.
  test('all predicates return a boolean for any string', () => {
    fc.assert(
      fc.property(fc.string(), s => {
        for (const predicate of [isEmail, isPurl, isScopedPackage, isUrl]) {
          expect(typeof predicate(s)).toBe('boolean')
        }
      }),
    )
  })

  // CONSTRUCTED-VALID: a well-shaped scoped package is recognized.
  test('isScopedPackage accepts constructed @scope/name', () => {
    fc.assert(
      fc.property(scopedPackage, spec => {
        expect(isScopedPackage(spec)).toBe(true)
      }),
    )
  })

  // CONSTRUCTED-VALID: a well-shaped purl is recognized.
  test('isPurl accepts constructed pkg: identifiers', () => {
    fc.assert(
      fc.property(purl, spec => {
        expect(isPurl(spec)).toBe(true)
      }),
    )
  })

  // CONSTRUCTED-VALID: a well-shaped email is recognized.
  test('isEmail accepts constructed local@label.tld', () => {
    fc.assert(
      fc.property(email, addr => {
        expect(isEmail(addr)).toBe(true)
      }),
    )
  })

  // CONSTRUCTED-VALID: a well-shaped absolute URL is recognized.
  test('isUrl accepts constructed scheme://rest', () => {
    fc.assert(
      fc.property(url, u => {
        expect(isUrl(u)).toBe(true)
      }),
    )
  })

  // RESTRICTED-INPUT (regression): a `name@digits.digits.digits` version string
  // is NOT an email — its final dotted segment is numeric, not a letter TLD.
  test('isEmail rejects package@version identifiers', () => {
    const versionSpec = fc
      .tuple(
        fromChars(ALNUM, 1, 12),
        fc.array(fc.nat({ max: 999 }).map(String), {
          minLength: 1,
          maxLength: 4,
        }),
      )
      .map(([name, parts]) => `${name}@${parts.join('.')}`)
    fc.assert(
      fc.property(versionSpec, spec => {
        expect(isEmail(spec)).toBe(false)
      }),
    )
  })

  // RESTRICTED-INPUT: a bare word carries none of the four structural anchors,
  // so every predicate rejects it.
  test('bare words are rejected by every predicate', () => {
    fc.assert(
      fc.property(bareWord, word => {
        expect(isEmail(word)).toBe(false)
        expect(isPurl(word)).toBe(false)
        expect(isScopedPackage(word)).toBe(false)
        expect(isUrl(word)).toBe(false)
      }),
    )
  })

  // RESTRICTED-INPUT: dropping the `pkg:` prefix makes an otherwise-purl-shaped
  // string fail the purl check.
  test('isPurl rejects identifiers missing the pkg: scheme', () => {
    fc.assert(
      fc.property(
        fc.array(fromChars(ALNUM, 1, 10), { minLength: 1, maxLength: 3 }),
        segments => {
          expect(isPurl(`npm/${segments.join('/')}`)).toBe(false)
        },
      ),
    )
  })
})
