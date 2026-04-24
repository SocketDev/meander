/** @fileoverview Unit tests for applyBasePathToHtml. */

import { describe, expect, it } from 'vitest'

import { applyBasePathToHtml } from '../src/url-rewrite.mts'

describe('applyBasePathToHtml', () => {
  it('no-ops when basePath is empty', () => {
    const html = '<a href="/foo">x</a>'
    expect(applyBasePathToHtml(html, '')).toBe(html)
  })

  it('prefixes root-relative href + src', () => {
    const html = '<a href="/page"><img src="/img/a.png"></a>'
    const out = applyBasePathToHtml(html, '/meander')
    expect(out).toContain('href="/meander/page"')
    expect(out).toContain('src="/meander/img/a.png"')
  })

  it('leaves already-prefixed values alone (idempotent)', () => {
    const html = '<a href="/meander/docs">x</a>'
    expect(applyBasePathToHtml(html, '/meander')).toContain(
      'href="/meander/docs"',
    )
    /* Running twice must produce the same output. */
    const once = applyBasePathToHtml(html, '/meander')
    const twice = applyBasePathToHtml(once, '/meander')
    expect(twice).toBe(once)
  })

  it('only rewrites root-relative values — leaves absolute, hash-only, and relative alone', () => {
    const html = [
      '<a href="https://example.com/x">abs</a>',
      '<img src="data:image/png;base64,AAAA">',
      '<a href="#top">hash</a>',
      '<a href="./sibling">dot-rel</a>',
      '<a href="relative/path">rel</a>',
    ].join('')
    const out = applyBasePathToHtml(html, '/meander')
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('src="data:image/png;base64,AAAA"')
    expect(out).toContain('href="#top"')
    expect(out).toContain('href="./sibling"')
    expect(out).toContain('href="relative/path"')
    expect(out).not.toContain('/meander/')
  })

  it('handles the basePath-exact-match edge', () => {
    /* href="/meander" (no trailing slash) should stay as-is, not
     * become "/meander/meander". */
    const html = '<a href="/meander">home</a>'
    const out = applyBasePathToHtml(html, '/meander')
    expect(out).toContain('href="/meander"')
    expect(out).not.toContain('/meander/meander')
  })
})
