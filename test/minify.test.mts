/**
 * @file Tests for minify.mts — inline-script minify, SVG shrink, asset minify.
 */

import { describe, expect, it } from 'vitest'

import { minifyAsset, minifyEmittedHtml } from '../src/minify.mts'

describe('minifyEmittedHtml', () => {
  it('no-ops when both js + svg are disabled', async () => {
    const html =
      '<html><head><script>var x = 1;   var y = 2;</script></head></html>'
    const out = await minifyEmittedHtml(html, { js: false, svg: false })
    expect(out).toBe(html)
  })

  it('minifies inline <script> bodies', async () => {
    const html =
      '<html><head><script>const longName = 42;\n// a comment\nconsole.log(longName);</script></head></html>'
    const out = await minifyEmittedHtml(html, { js: true, svg: false })
    expect(out).not.toContain('// a comment')
    /* Comment removed + whitespace collapsed = shorter output. */
    expect(out.length).toBeLessThan(html.length)
  })

  it('leaves <script src="..."> tags alone (external, not inline)', async () => {
    const html = '<html><head><script src="/app.js"></script></head></html>'
    const out = await minifyEmittedHtml(html, { js: true, svg: false })
    expect(out).toContain('src="/app.js"')
  })

  it('skips empty-body inline scripts', async () => {
    const html = '<html><head><script></script></head></html>'
    const out = await minifyEmittedHtml(html, { js: true, svg: false })
    expect(out).toContain('<script></script>')
  })

  it('shrinks inline <svg> via SVGO', async () => {
    const verbose =
      '<html><body><svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">\n  <!-- comment -->\n  <rect x="0" y="0" width="100" height="100" fill="red" />\n</svg></body></html>'
    const out = await minifyEmittedHtml(verbose, { js: false, svg: true })
    expect(out).not.toContain('<!-- comment -->')
    expect(out.length).toBeLessThan(verbose.length)
  })

  it('returns original html when no inline targets exist', async () => {
    const html =
      '<html><head></head><body><p>no inline anything</p></body></html>'
    const out = await minifyEmittedHtml(html)
    expect(out).toBe(html)
  })

  it('survives malformed inline JS (best-effort, logs + keeps original)', async () => {
    /* Intentionally invalid syntax — esbuild will reject. The
     * minifier should log + move on without throwing. */
    const html = '<html><head><script>const broken = ;</script></head></html>'
    const out = await minifyEmittedHtml(html, { js: true, svg: false })
    /* Original content preserved. */
    expect(out).toContain('const broken = ;')
  })
})

describe('minifyAsset', () => {
  it('minifies JS source', async () => {
    const code = 'const longName = 42;\n// a comment\nconsole.log(longName);'
    const out = await minifyAsset(code, 'js')
    expect(out).not.toContain('// a comment')
    expect(out.length).toBeLessThan(code.length)
  })

  it('minifies CSS source', async () => {
    const code = 'body {\n  color: red;\n  /* note */\n  background: white;\n}'
    const out = await minifyAsset(code, 'css')
    expect(out).not.toContain('/* note */')
    expect(out.length).toBeLessThan(code.length)
  })

  it('returns original source on failure (no throw)', async () => {
    const bad = 'const broken = ;'
    const out = await minifyAsset(bad, 'js')
    expect(out).toBe(bad)
  })
})
