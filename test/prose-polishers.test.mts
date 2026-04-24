/** @fileoverview Tests for prose-polishers.mts. */

import { describe, expect, it } from 'vitest'

import {
  anchorifyHeadings,
  enhanceRepoTrees,
  highlightProseNumbers,
  italicizeParentheticals,
  polishProse,
  stripFurtherReading,
} from '../src/prose-polishers.mts'

describe('highlightProseNumbers', () => {
  it('wraps version numbers, percentages, counts in <p>', () => {
    const html = '<p>Ships 1.2.3 and covers 95% of 42 cases.</p>'
    const out = highlightProseNumbers(html)
    expect(out).toContain('<span class="mdr-num">1.2.3</span>')
    expect(out).toContain('<span class="mdr-num">95%</span>')
    expect(out).toContain('<span class="mdr-num">42</span>')
  })

  it('skips numbers inside <code>, <pre>, <a>', () => {
    const html =
      '<p>normal 3.14 <code>inside 2.71</code> <a href="/">link 1.1</a></p>'
    const out = highlightProseNumbers(html)
    expect(out).toContain('<span class="mdr-num">3.14</span>')
    expect(out).not.toContain('inside <span')
    expect(out).toContain('inside 2.71')
    expect(out).toContain('link 1.1')
  })

  it('leaves bold list markers like **1.** alone', () => {
    const html = '<ul><li><strong>1.</strong> First item 2.3 in prose</li></ul>'
    const out = highlightProseNumbers(html)
    expect(out).toContain('<strong>1.</strong>')
    expect(out).not.toContain('<span class="mdr-num">1</span>')
    expect(out).toContain('<span class="mdr-num">2.3</span>')
  })

  it('touches h1-h4 headings but not h5-h6', () => {
    const html =
      '<h1>Title 1.0</h1><h4>Sub 4.0</h4><h5>Deep 5.0</h5><h6>Deeper 6.0</h6>'
    const out = highlightProseNumbers(html)
    expect(out).toContain('<span class="mdr-num">1.0</span>')
    expect(out).toContain('<span class="mdr-num">4.0</span>')
    /* h5/h6 aren't in the allowed set — their numbers stay plain. */
    expect(out).toContain('<h5>Deep 5.0</h5>')
    expect(out).toContain('<h6>Deeper 6.0</h6>')
  })
})

describe('italicizeParentheticals', () => {
  it('wraps (parenthetical asides) in <em>', () => {
    const html = '<p>Do the thing (if possible) right now.</p>'
    const out = italicizeParentheticals(html)
    expect(out).toContain('(<em>if possible</em>)')
  })

  it('leaves code/pre content alone', () => {
    const html = '<p><code>fn(arg)</code> but do (fix it).</p>'
    const out = italicizeParentheticals(html)
    expect(out).toContain('<code>fn(arg)</code>')
    expect(out).toContain('(<em>fix it</em>)')
  })

  it('wraps the innermost paren group when parens nest', () => {
    /* The regex `/\([^()…]{2,}\)/` can't span nested parens, so
     * the *inner* `(deep)` gets wrapped and the outer pair
     * remains untouched as literal text. */
    const html = '<p>Something (nested (deep) aside).</p>'
    const out = italicizeParentheticals(html)
    expect(out).toContain('(<em>deep</em>)')
    /* Outer parens around "nested ... aside" are preserved as text. */
    expect(out).toContain('(nested')
    expect(out).toContain('aside)')
  })
})

describe('anchorifyHeadings', () => {
  it('adds id + #anchor to h2/h3/h4', () => {
    const html = '<h2>First Section</h2><h3>Nested</h3>'
    const out = anchorifyHeadings(html)
    expect(out).toContain('id="first-section"')
    expect(out).toContain('id="nested"')
    expect(out).toContain('href="#first-section"')
    expect(out).toContain('mdr-heading-anchor')
  })

  it('skips h1', () => {
    const html = '<h1>Page Title</h1>'
    const out = anchorifyHeadings(html)
    expect(out).not.toContain('id="page-title"')
  })

  it('is idempotent', () => {
    const html = '<h2>Hello World</h2>'
    const once = anchorifyHeadings(html)
    const twice = anchorifyHeadings(once)
    expect(twice).toBe(once)
  })

  it('disambiguates duplicate heading slugs', () => {
    const html = '<h2>Usage</h2><h3>Usage</h3>'
    const out = anchorifyHeadings(html)
    expect(out).toContain('id="usage"')
    expect(out).toContain('id="usage-2"')
  })

  it('preserves pre-existing id attributes', () => {
    const html = '<h2 id="custom">Title</h2>'
    const out = anchorifyHeadings(html)
    expect(out).toContain('id="custom"')
    expect(out).toContain('href="#custom"')
  })

  it('skips empty headings (no text)', () => {
    const html = '<h2></h2><h3>Real</h3>'
    const out = anchorifyHeadings(html)
    expect(out).toContain('id="real"')
    /* Empty heading gets no id AND no permalink anchor inserted. */
    const anchors = out.match(/mdr-heading-anchor/g) ?? []
    expect(anchors.length).toBe(1)
  })

  it('skips headings whose text slug-reduces to empty (punctuation-only)', () => {
    /* Distinct branch from above — text is non-empty but the
     * non-letter/number filter strips it down to nothing. */
    const html = '<h2>!!!</h2><h3>Real</h3>'
    const out = anchorifyHeadings(html)
    expect(out).toContain('id="real"')
    const anchors = out.match(/mdr-heading-anchor/g) ?? []
    expect(anchors.length).toBe(1)
  })
})

describe('enhanceRepoTrees', () => {
  it('marks <pre> blocks containing tree-drawing glyphs', () => {
    const html = '<pre><code>src/\n├── a.ts\n└── b.ts</code></pre>'
    const out = enhanceRepoTrees(html)
    expect(out).toContain('mdr-repo-tree')
    expect(out).toContain('nohighlight')
  })

  it('leaves plain <pre> blocks untouched', () => {
    const html = '<pre><code>console.log("hi")</code></pre>'
    const out = enhanceRepoTrees(html)
    expect(out).not.toContain('mdr-repo-tree')
    expect(out).not.toContain('nohighlight')
  })

  it('merges nohighlight into an existing <code class> attribute', () => {
    const html =
      '<pre><code class="lang-text">src/\n├── a.ts\n└── b.ts</code></pre>'
    const out = enhanceRepoTrees(html)
    expect(out).toContain('class="lang-text nohighlight"')
  })

  it('is idempotent — second pass over already-marked tree is a no-op', () => {
    const html = '<pre><code>src/\n├── a.ts\n└── b.ts</code></pre>'
    const once = enhanceRepoTrees(html)
    const twice = enhanceRepoTrees(once)
    expect(twice).toBe(once)
  })
})

describe('stripFurtherReading', () => {
  it('drops the "Further reading" section + its siblings until the next h2', () => {
    const html =
      '<h2>Body</h2><p>keep</p><h2>Further reading</h2><ul><li>remove</li></ul><p>also remove</p><h2>Next</h2><p>keep next</p>'
    const out = stripFurtherReading(html)
    expect(out).toContain('Body')
    expect(out).toContain('keep')
    expect(out).not.toContain('Further reading')
    expect(out).not.toContain('remove')
    expect(out).toContain('Next')
    expect(out).toContain('keep next')
  })

  it('matches case-insensitively + tolerates trailing punctuation', () => {
    const html = '<h2>Further Reading:</h2><p>to remove</p>'
    const out = stripFurtherReading(html)
    expect(out).not.toContain('to remove')
  })

  it('no-ops when no Further Reading heading exists', () => {
    const html = '<h2>Normal</h2><p>stays</p>'
    const out = stripFurtherReading(html)
    expect(out).toContain('stays')
    expect(out).toContain('Normal')
  })
})

describe('polishProse', () => {
  it('runs every pass in the canonical order', () => {
    const html =
      '<h2>API Reference</h2><p>Ships 95% today (finally).</p><h2>Further reading</h2><p>remove</p>'
    const out = polishProse(html)
    expect(out).toContain('id="api-reference"')
    expect(out).toContain('<span class="mdr-num">95%</span>')
    expect(out).toContain('(<em>finally</em>)')
    expect(out).not.toContain('remove')
  })
})
