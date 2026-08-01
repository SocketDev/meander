/**
 * @file Tests for MeanderConfigSchema + resolveOptOuts + loadMeanderConfig.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MeanderConfig } from '../src/config.mts'
import { loadMeanderConfig, resolveOptOuts } from '../src/config.mts'

function minimalConfig(extra: Partial<MeanderConfig> = {}): MeanderConfig {
  return {
    slug: 'test',
    title: 'Test',
    parts: [
      {
        id: 1,
        title: 'Intro',
        objective: 'An introduction.',
        keywords: ['intro'],
        files: ['src/a.ts'],
      },
    ],
    ...extra,
  }
}

describe('resolveOptOuts', () => {
  it('applies defaults when opt-out fields are absent', () => {
    const r = resolveOptOuts(minimalConfig())
    expect(r.comments.enabled).toBe(true)
    expect(r.comments.ui).toBe(true)
    expect(r.comments.styles).toBe(true)
    expect(r.comments.backend).toBeUndefined()
    expect(r.comments.allowedEmailDomains).toEqual([])
    expect(r.comments.seedPath).toBeUndefined()
    expect(r.theme.enabled).toBe(true)
    expect(r.theme.themes).toEqual(['system', 'light', 'dark', 'neo-kiju'])
    expect(r.styles.base).toBe(true)
    expect(r.styles.theme).toBe(true)
    expect(r.styles.ui).toBe(true)
    expect(r.styles.comments).toBe(true)
    expect(r.styles.prose).toBe(true)
    expect(r.demoMode).toBe(false)
    expect(r.outDir).toBe('pages')
  })

  it('`comments: false` zeros the entire comment surface', () => {
    const r = resolveOptOuts(minimalConfig({ comments: false }))
    expect(r.comments.enabled).toBe(false)
    expect(r.comments.ui).toBe(false)
    expect(r.comments.styles).toBe(false)
    /* When comments are fully disabled, backend + email gating +
     * seeds should also reset — no partial state that a consumer
     * could accidentally rely on. */
    expect(r.comments.backend).toBeUndefined()
    expect(r.comments.allowedEmailDomains).toEqual([])
    expect(r.comments.seedPath).toBeUndefined()
  })

  /* `comments: true` is a separate input branch from absent
   * (shorthand literal vs the `obj ?? true` path). Both produce
   * defaults, but testing `true` explicitly guards against a
   * future refactor accidentally making them diverge. */
  it('`comments: true` hits the true-shorthand branch', () => {
    const r = resolveOptOuts(minimalConfig({ comments: true }))
    expect(r.comments.enabled).toBe(true)
    expect(r.comments.ui).toBe(true)
    expect(r.comments.styles).toBe(true)
  })

  it('`comments: { enabled: false }` wins over defaults', () => {
    const r = resolveOptOuts(
      minimalConfig({ comments: { enabled: false, ui: true } }),
    )
    expect(r.comments.enabled).toBe(false)
    expect(r.comments.ui).toBe(false)
    expect(r.comments.styles).toBe(false)
  })

  it('`comments: { enabled: true }` honors per-field opt-outs', () => {
    const r = resolveOptOuts(
      minimalConfig({ comments: { ui: false, styles: true } }),
    )
    expect(r.comments.enabled).toBe(true)
    expect(r.comments.ui).toBe(false)
    expect(r.comments.styles).toBe(true)
  })

  it('`comments` object surfaces backend + allowedEmailDomains + seedPath', () => {
    const r = resolveOptOuts(
      minimalConfig({
        comments: {
          backend: 'https://example.web.val.run',
          allowedEmailDomains: ['gmail.com', 'socket.dev'],
          seedPath: './seeds.json',
        },
      }),
    )
    expect(r.comments.backend).toBe('https://example.web.val.run')
    expect(r.comments.allowedEmailDomains).toEqual(['gmail.com', 'socket.dev'])
    expect(r.comments.seedPath).toBe('./seeds.json')
  })

  it('`theme: false` drops theme stack entirely', () => {
    const r = resolveOptOuts(minimalConfig({ theme: false }))
    expect(r.theme.enabled).toBe(false)
    expect(r.theme.themes).toEqual([])
  })

  it('`theme: { themes: [...] }` narrows the allowed set', () => {
    const r = resolveOptOuts(
      minimalConfig({ theme: { themes: ['light', 'dark'] } }),
    )
    expect(r.theme.themes).toEqual(['light', 'dark'])
  })

  it('`styles: false` zeros every bucket', () => {
    const r = resolveOptOuts(minimalConfig({ styles: false }))
    expect(r.styles.base).toBe(false)
    expect(r.styles.theme).toBe(false)
    expect(r.styles.ui).toBe(false)
    expect(r.styles.comments).toBe(false)
    expect(r.styles.prose).toBe(false)
  })

  it('styles.comments auto-follows comments.enabled when not overridden', () => {
    const off = resolveOptOuts(minimalConfig({ comments: false }))
    expect(off.styles.comments).toBe(false)

    const explicit = resolveOptOuts(
      minimalConfig({ comments: false, styles: { comments: true } }),
    )
    expect(explicit.styles.comments).toBe(true)
  })

  it('demoMode + outDir flow through untouched', () => {
    const r = resolveOptOuts(minimalConfig({ demoMode: true, outDir: 'site' }))
    expect(r.demoMode).toBe(true)
    expect(r.outDir).toBe('site')
  })
})

describe('loadMeanderConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'meander-config-'))
  })

  afterEach(async () => {
    await safeDelete(tmpDir, { recursive: true, force: true })
  })

  function writeConfig(body: unknown): string {
    const p = path.join(tmpDir, 'meander.config.json')
    writeFileSync(p, JSON.stringify(body), 'utf-8')
    return p
  }

  it('loads a minimal valid config + returns resolved opt-outs', () => {
    const p = writeConfig(minimalConfig())
    const { config, resolved } = loadMeanderConfig(p)
    expect(config.slug).toBe('test')
    expect(config.parts.length).toBe(1)
    expect(resolved.outDir).toBe('pages')
  })

  it('throws on invalid slug shape', () => {
    const p = writeConfig(minimalConfig({ slug: 'Has Uppercase & Space' }))
    expect(() => loadMeanderConfig(p)).toThrow(/invalid meander config/i)
  })

  it('throws on empty parts array', () => {
    const p = writeConfig(minimalConfig({ parts: [] }))
    expect(() => loadMeanderConfig(p)).toThrow(/invalid meander config/i)
  })

  it('throws when two parts share the same filename', () => {
    const p = writeConfig(
      minimalConfig({
        parts: [
          {
            id: 1,
            title: 'One',
            objective: 'x',
            keywords: ['a'],
            files: ['x.ts'],
            filename: 'shared',
          },
          {
            id: 2,
            title: 'Two',
            objective: 'y',
            keywords: ['b'],
            files: ['y.ts'],
            filename: 'shared',
          },
        ],
      }),
    )
    expect(() => loadMeanderConfig(p)).toThrow(
      /filename "shared" is used by both/i,
    )
  })

  it('throws when a part and a doc share the same filename', () => {
    const p = writeConfig(
      minimalConfig({
        documents: [{ source: 'docs/overview.md', filename: 'overview' }],
        parts: [
          {
            id: 1,
            title: 'One',
            objective: 'x',
            keywords: ['a'],
            files: ['x.ts'],
            filename: 'overview',
          },
        ],
      }),
    )
    expect(() => loadMeanderConfig(p)).toThrow(
      /filename "overview" is used by both/i,
    )
  })

  it('accepts shorthand string doc entries', () => {
    const p = writeConfig(
      minimalConfig({ documents: ['docs/a.md', 'docs/b.md'] }),
    )
    const { config } = loadMeanderConfig(p)
    expect(config.documents).toEqual(['docs/a.md', 'docs/b.md'])
  })

  it('accepts full-form doc entries without a filename (no uniqueness check)', () => {
    const p = writeConfig(
      minimalConfig({
        documents: [{ source: 'docs/a.md' }, { source: 'docs/b.md' }],
      }),
    )
    const { config } = loadMeanderConfig(p)
    expect(config.documents?.length).toBe(2)
  })

  it('accepts full-form doc entries with metadata', () => {
    const p = writeConfig(
      minimalConfig({
        documents: [
          {
            source: 'docs/a.md',
            filename: 'intro',
            title: 'Intro',
            summary: 's',
          },
        ],
      }),
    )
    const { config } = loadMeanderConfig(p)
    expect(config.documents).toEqual([
      { source: 'docs/a.md', filename: 'intro', title: 'Intro', summary: 's' },
    ])
  })

  it('rejects outDir with invalid pattern', () => {
    const p = writeConfig(minimalConfig({ outDir: 'Has Caps' }))
    expect(() => loadMeanderConfig(p)).toThrow(/invalid meander config/i)
  })

  it('surfaces JSON parse errors from SyntaxError', () => {
    const p = path.join(tmpDir, 'meander.config.json')
    writeFileSync(p, '{ not json', 'utf-8')
    expect(() => loadMeanderConfig(p)).toThrow(SyntaxError)
  })
})
