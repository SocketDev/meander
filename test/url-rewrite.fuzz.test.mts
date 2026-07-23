/**
 * @file Property/fuzz tests for src/url-rewrite (Tier-1 fast-check).
 *   `applyBasePathToHtml(html, basePath)` prefixes `basePath` onto
 *   root-relative [href]/[src] URLs in user-authored HTML. Contracts (from the
 *   module doc):
 *
 *   - IDENTITY: an empty basePath is a no-op — the exact input is returned.
 *   - IDEMPOTENCE: running the pass twice equals running it once.
 *   - NEVER-THROWS: any (html, basePath) pair yields a string.
 *   - DERIVED-FROM-INPUT: a root-relative URL gains exactly the basePath prefix;
 *     protocol, hash-only, and already-prefixed URLs are left untouched. HTML
 *     fragments are CONSTRUCTED from a fixed anchor/img template so the
 *     expected rewrite is knowable without reparsing.
 */

import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { applyBasePathToHtml } from '../src/url-rewrite.mts'

const LOWER = 'abcdefghijklmnopqrstuvwxyz'

function fromChars(alphabet: string, minLength: number, maxLength: number) {
  return fc
    .array(fc.constantFrom(...alphabet.split('')), { minLength, maxLength })
    .map(chars => chars.join(''))
}

const word = fromChars(LOWER, 1, 8)
const pathTail = fc
  .array(word, { minLength: 1, maxLength: 3 })
  .map(parts => parts.join('/'))

// `/base` — no trailing slash (the pass concatenates basePath + a slash-led
// value, so a trailing slash would double up).
const basePath = word.map(w => `/${w}`)

// URL kinds the pass must NOT rewrite: absolute (protocol), hash-only, and
// plain-relative (no leading slash).
const rootRelative = pathTail.map(p => `/${p}`)
const protocolUrl = fc
  .tuple(fc.constantFrom('https', 'http', 'data'), pathTail)
  .map(([scheme, p]) => `${scheme}://example.com/${p}`)
const hashOnly = word.map(w => `#${w}`)
const plainRelative = pathTail

const anyHref = fc.oneof(rootRelative, protocolUrl, hashOnly, plainRelative)

// A small HTML body of anchors + images with generated href/src values.
const htmlBody = fc
  .array(
    fc.oneof(
      anyHref.map(h => `<a href="${h}">x</a>`),
      anyHref.map(h => `<img src="${h}">`),
    ),
    { minLength: 0, maxLength: 6 },
  )
  .map(nodes => `<div>${nodes.join('')}</div>`)

describe('url-rewrite — fuzz', () => {
  // IDENTITY (classical #3, restricted input): an empty basePath returns the
  // exact same string reference-equal-by-value.
  test('empty basePath returns the input unchanged', () => {
    fc.assert(
      fc.property(fc.string(), html => {
        expect(applyBasePathToHtml(html, '')).toBe(html)
      }),
    )
  })

  // NEVER-THROWS: the pass tolerates arbitrary html + basePath strings.
  test('never throws and always returns a string', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (html, base) => {
        expect(typeof applyBasePathToHtml(html, base)).toBe('string')
      }),
    )
  })

  // IDEMPOTENCE (documented): a second pass over already-rewritten HTML is a
  // no-op.
  test('applying the pass twice equals applying it once', () => {
    fc.assert(
      fc.property(htmlBody, basePath, (html, base) => {
        const once = applyBasePathToHtml(html, base)
        const twice = applyBasePathToHtml(once, base)
        expect(twice).toBe(once)
      }),
    )
  })

  // DERIVED-FROM-INPUT: a single root-relative href gains exactly the basePath
  // prefix.
  test('root-relative URLs gain the basePath prefix', () => {
    fc.assert(
      fc.property(rootRelative, basePath, (href, base) => {
        const out = applyBasePathToHtml(`<a href="${href}">x</a>`, base)
        expect(out).toContain(`${base}${href}`)
      }),
    )
  })

  // RESTRICTED-INPUT: HTML whose URLs are all protocol/hash/plain-relative has
  // no root-relative target, so the pass returns it unchanged.
  test('HTML with no root-relative URLs is returned unchanged', () => {
    const nonRootHref = fc.oneof(protocolUrl, hashOnly, plainRelative)
    const nonRootBody = fc
      .array(
        nonRootHref.map(h => `<a href="${h}">x</a>`),
        {
          minLength: 1,
          maxLength: 5,
        },
      )
      .map(nodes => `<div>${nodes.join('')}</div>`)
    fc.assert(
      fc.property(nonRootBody, basePath, (html, base) => {
        expect(applyBasePathToHtml(html, base)).toBe(html)
      }),
    )
  })

  // DERIVED-FROM-INPUT: protocol URLs survive verbatim even when other links on
  // the page get rewritten.
  test('protocol URLs are preserved verbatim', () => {
    fc.assert(
      fc.property(protocolUrl, rootRelative, basePath, (abs, rel, base) => {
        const out = applyBasePathToHtml(
          `<a href="${abs}">a</a><a href="${rel}">b</a>`,
          base,
        )
        expect(out).toContain(abs)
      }),
    )
  })
})
