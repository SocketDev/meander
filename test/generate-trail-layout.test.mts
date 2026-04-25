/**
 * @fileoverview Integration tests for the index page's trail
 * (row) layout. Covers `layout: 'auto' | 'cards' | 'rows'`,
 * `kind: 'code' | 'article'`, the auto-promote-at-12 threshold,
 * the search-filter-at-24 threshold, and backward compatibility
 * with configs that don't specify `layout` or `kind`.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { safeDelete } from '@socketsecurity/lib/fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generate } from '../src/generate.mts'

describe('generate index trail layout', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'meander-trail-'))
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
    writeFileSync(
      path.join(tmpDir, 'src/app.ts'),
      '/* Greets the world. */\nexport function greet() { return "hi" }\n',
      'utf-8',
    )
  })

  afterEach(async () => {
    await safeDelete(tmpDir, { recursive: true, force: true })
  })

  function makePart(id: number) {
    return {
      id,
      title: `Marker ${id}`,
      objective: `Objective for marker ${id}.`,
      keywords: [`kw${id}`],
      files: ['src/app.ts'],
    }
  }

  function writeConfig(parts: number, extra: Record<string, unknown>): string {
    const p = path.join(tmpDir, 'meander.config.json')
    const partList = Array.from({ length: parts }, (_, i) => makePart(i + 1))
    writeFileSync(
      p,
      JSON.stringify({
        slug: 'trail',
        title: 'Trail fixture',
        parts: partList,
        ...extra,
      }),
      'utf-8',
    )
    return p
  }

  function readIndex(): string {
    return readFileSync(path.join(tmpDir, 'pages', 'index.html'), 'utf-8')
  }

  /* ---------- layout: auto resolves by count ---------- */

  it('auto layout below 12 markers picks cards', async () => {
    await generate(writeConfig(3, {}), { __proto__: null } as {
      __proto__: null
    })
    const index = readIndex()
    expect(index).toContain('mdr-toc-grid')
    expect(index).toContain('mdr-toc-card')
    expect(index).not.toContain('mdr-trail-list')
  })

  it('auto layout at 12 markers promotes to rows', async () => {
    await generate(writeConfig(12, {}), { __proto__: null } as {
      __proto__: null
    })
    const index = readIndex()
    expect(index).toContain('mdr-trail-list')
    expect(index).not.toContain('mdr-toc-grid')
  })

  /* ---------- explicit layout overrides count ---------- */

  it('explicit cards keeps grid at high count', async () => {
    await generate(writeConfig(20, { layout: 'cards' }), {
      __proto__: null,
    } as { __proto__: null })
    const index = readIndex()
    expect(index).toContain('mdr-toc-grid')
    expect(index).not.toContain('mdr-trail-list')
  })

  it('explicit rows uses trail list at low count', async () => {
    await generate(writeConfig(3, { layout: 'rows' }), { __proto__: null } as {
      __proto__: null
    })
    const index = readIndex()
    expect(index).toContain('mdr-trail-list')
    expect(index).not.toContain('mdr-toc-grid')
  })

  /* ---------- filter input gates on count ---------- */

  it('filter input is absent below 24 rows', async () => {
    await generate(writeConfig(20, { layout: 'rows' }), {
      __proto__: null,
    } as { __proto__: null })
    const index = readIndex()
    expect(index).not.toContain('mdr-trail-filter')
  })

  it('filter input appears at 24 rows', async () => {
    await generate(writeConfig(24, { layout: 'rows' }), {
      __proto__: null,
    } as { __proto__: null })
    const index = readIndex()
    expect(index).toContain('mdr-trail-filter')
    expect(index).toContain('mdr-trail-count')
    /* Filter script ships inline only when the input is rendered. */
    expect(index).toContain('mdr-trail-filter')
  })

  /* ---------- kind glyph + mixed-kind detection ---------- */

  it('all-code trail uses single-kind class (suppresses glyph)', async () => {
    await generate(writeConfig(12, {}), { __proto__: null } as {
      __proto__: null
    })
    const index = readIndex()
    expect(index).toContain('mdr-trail-single')
    expect(index).not.toContain('mdr-trail-mixed')
  })

  it('part with kind: article flips trail to mixed', async () => {
    const partList = Array.from({ length: 12 }, (_, i) => makePart(i + 1))
    /* Override the second part's kind. */
    ;(partList[1] as { kind?: string }).kind = 'article'
    const cfg = path.join(tmpDir, 'meander.config.json')
    writeFileSync(
      cfg,
      JSON.stringify({
        slug: 'trail',
        title: 'Trail fixture',
        parts: partList,
      }),
      'utf-8',
    )
    await generate(cfg, { __proto__: null } as { __proto__: null })
    const index = readIndex()
    expect(index).toContain('mdr-trail-mixed')
    expect(index).toContain('data-kind="article"')
    expect(index).toContain('data-kind="code"')
  })

  /* ---------- backward compatibility ---------- */

  it('config without layout key still validates and renders', async () => {
    await generate(writeConfig(3, {}), { __proto__: null } as {
      __proto__: null
    })
    const index = readIndex()
    /* Renders something — the cards path. */
    expect(index).toContain('mdr-toc-grid')
  })

  it('config without kind on parts defaults to code', async () => {
    await generate(writeConfig(12, {}), { __proto__: null } as {
      __proto__: null
    })
    const index = readIndex()
    /* Every row stamps data-kind, defaulted to "code". */
    expect(index).toMatch(/data-kind="code"/)
    expect(index).not.toMatch(/data-kind="article"/)
  })

  /* ---------- numbering + size pill ---------- */

  it('rows render zero-padded tabular nums', async () => {
    await generate(writeConfig(12, {}), { __proto__: null } as {
      __proto__: null
    })
    const index = readIndex()
    /* First row is "01", twelfth is "12". */
    expect(index).toContain('>01<')
    expect(index).toContain('>12<')
  })

  it('sizeTiers true stamps trail size pill class', async () => {
    await generate(writeConfig(12, { sizeTiers: true }), {
      __proto__: null,
    } as { __proto__: null })
    const index = readIndex()
    /* At minimum the smallest tier — 1-line `src/app.ts` content
     * lands in x-small. */
    expect(index).toMatch(/mdr-trail-size-x-small/)
  })

  it('sizeTiers omitted suppresses trail size pill', async () => {
    await generate(writeConfig(12, {}), { __proto__: null } as {
      __proto__: null
    })
    const index = readIndex()
    expect(index).not.toContain('mdr-trail-size-')
  })
})
