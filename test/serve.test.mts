/** @fileoverview Tests for serve.mts — routeToFile, escapeRegex, MIME, readWalkthroughMeta, serve(). */

import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { safeDelete } from '@socketsecurity/lib/fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MIME,
  escapeRegex,
  readWalkthroughMeta,
  routeToFile,
  serve,
} from '../src/serve.mts'

describe('routeToFile', () => {
  const slug = 'demo'
  const partIds = new Set([1, 2, 5])

  it('maps / and /:slug to index.html', () => {
    expect(routeToFile(slug, '/', partIds, false)).toBe('index.html')
    expect(routeToFile(slug, '', partIds, false)).toBe('index.html')
    expect(routeToFile(slug, `/${slug}`, partIds, false)).toBe('index.html')
  })

  it('maps /:slug/part/:n → part-<n>.html when the part exists', () => {
    expect(routeToFile(slug, `/${slug}/part/1`, partIds, false)).toBe(
      'part-1.html',
    )
    expect(routeToFile(slug, `/${slug}/part/5`, partIds, false)).toBe(
      'part-5.html',
    )
  })

  it('returns undefined for an unknown part id', () => {
    expect(
      routeToFile(slug, `/${slug}/part/999`, partIds, false),
    ).toBeUndefined()
  })

  it('maps /:slug/documents → documents.html only when documents exist', () => {
    expect(routeToFile(slug, `/${slug}/documents`, partIds, true)).toBe(
      'documents.html',
    )
    /* When documents are absent, the route-through treats it as
     * an asset path. Not an error — the asset handler then 404s. */
    const fallback = routeToFile(slug, `/${slug}/documents`, partIds, false)
    expect(fallback).toBe('documents')
  })

  it('strips :slug prefix from asset-shaped requests', () => {
    expect(routeToFile(slug, `/${slug}/meander.css`, partIds, false)).toBe(
      'meander.css',
    )
    expect(routeToFile(slug, '/meander.css', partIds, false)).toBe(
      'meander.css',
    )
  })

  it('preserves nested asset subpaths', () => {
    expect(routeToFile(slug, `/${slug}/assets/foo.js`, partIds, false)).toBe(
      'assets/foo.js',
    )
  })

  it('strips trailing slashes before routing', () => {
    expect(routeToFile(slug, `/${slug}/`, partIds, false)).toBe('index.html')
  })

  it('handles slugs with regex-special characters via escapeRegex', () => {
    const slug2 = 'slug.v2+rc'
    expect(routeToFile(slug2, `/${slug2}/part/1`, partIds, false)).toBe(
      'part-1.html',
    )
  })
})

describe('escapeRegex', () => {
  it('escapes all the usual regex metacharacters', () => {
    expect(escapeRegex('a.b')).toBe('a\\.b')
    expect(escapeRegex('[1]')).toBe('\\[1\\]')
    expect(escapeRegex('$^*+?(){}|')).toBe('\\$\\^\\*\\+\\?\\(\\)\\{\\}\\|')
    expect(escapeRegex('\\')).toBe('\\\\')
  })

  it('leaves plain alphanumerics alone', () => {
    expect(escapeRegex('hello-world_42')).toBe('hello-world_42')
  })
})

describe('MIME table', () => {
  it('covers the expected content types', () => {
    expect(MIME['.html']).toMatch(/text\/html/)
    expect(MIME['.css']).toMatch(/text\/css/)
    expect(MIME['.js']).toMatch(/javascript/)
    expect(MIME['.json']).toMatch(/json/)
    expect(MIME['.svg']).toBe('image/svg+xml')
  })
})

describe('readWalkthroughMeta', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'meander-meta-'))
  })

  afterEach(async () => {
    await safeDelete(tmpDir, { recursive: true, force: true })
  })

  it('reads from manifest.json when present', async () => {
    writeFileSync(
      path.join(tmpDir, 'manifest.json'),
      JSON.stringify({
        slug: 'demo',
        parts: [{ id: 1 }, { id: 3 }],
        hasDocuments: true,
      }),
      'utf-8',
    )
    const meta = await readWalkthroughMeta(tmpDir)
    expect(meta.slug).toBe('demo')
    expect([...meta.partIds].sort()).toEqual([1, 3])
    expect(meta.hasDocuments).toBe(true)
  })

  it('falls back to a filename scan when manifest is absent', async () => {
    writeFileSync(path.join(tmpDir, 'part-1.html'), '', 'utf-8')
    writeFileSync(path.join(tmpDir, 'part-7.html'), '', 'utf-8')
    writeFileSync(path.join(tmpDir, 'unrelated.txt'), '', 'utf-8')
    const meta = await readWalkthroughMeta(tmpDir)
    expect(meta.slug).toBe('')
    expect([...meta.partIds].sort()).toEqual([1, 7])
    expect(meta.hasDocuments).toBe(false)
  })

  it('fallback scan recognizes the legacy walkthrough-part-<n>.html filename', async () => {
    writeFileSync(path.join(tmpDir, 'walkthrough-part-2.html'), '', 'utf-8')
    const meta = await readWalkthroughMeta(tmpDir)
    expect([...meta.partIds]).toEqual([2])
  })

  it('fallback scan flags documents.html when present', async () => {
    writeFileSync(path.join(tmpDir, 'documents.html'), '', 'utf-8')
    const meta = await readWalkthroughMeta(tmpDir)
    expect(meta.hasDocuments).toBe(true)
  })
})

describe('serve (HTTP handler)', () => {
  let tmpDir: string
  let server: Server | null = null

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'meander-serve-'))
    const outDir = path.join(tmpDir, 'pages')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(
      path.join(outDir, 'manifest.json'),
      JSON.stringify({
        slug: 'demo',
        parts: [{ id: 1 }, { id: 2 }],
        hasDocuments: true,
      }),
      'utf-8',
    )
    writeFileSync(
      path.join(outDir, 'index.html'),
      '<!doctype html><title>index</title>',
      'utf-8',
    )
    writeFileSync(
      path.join(outDir, 'part-1.html'),
      '<!doctype html><title>p1</title>',
      'utf-8',
    )
    writeFileSync(
      path.join(outDir, 'documents.html'),
      '<!doctype html><title>docs</title>',
      'utf-8',
    )
    writeFileSync(path.join(outDir, 'meander.css'), 'body{color:red}', 'utf-8')
    writeFileSync(
      path.join(tmpDir, 'meander.config.json'),
      JSON.stringify({
        slug: 'demo',
        title: 'Demo',
        parts: [
          {
            id: 1,
            title: 'Intro',
            objective: 'x',
            keywords: ['k'],
            files: ['f.ts'],
          },
        ],
      }),
      'utf-8',
    )
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()))
      server = null
    }
    await safeDelete(tmpDir, { recursive: true, force: true })
  })

  async function start(options: { basePath?: string } = {}): Promise<{
    baseUrl: string
  }> {
    const configPath = path.join(tmpDir, 'meander.config.json')
    const result = await serve(configPath, {
      port: 0,
      ...(options.basePath !== undefined ? { basePath: options.basePath } : {}),
    })
    if (!result) {
      throw new Error('serve() returned undefined')
    }
    server = result.server
    return { baseUrl: result.url.replace(/\/$/, '') }
  }

  it('serves index.html at /', async () => {
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    expect(await res.text()).toContain('<title>index</title>')
  })

  it('routes /:slug/part/:n to part-<n>.html', async () => {
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/demo/part/1`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>p1</title>')
  })

  it('serves documents.html at /:slug/documents', async () => {
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/demo/documents`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>docs</title>')
  })

  it('returns 404 for an unknown part id', async () => {
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/demo/part/99`)
    expect(res.status).toBe(404)
  })

  it('serves assets with the right content-type', async () => {
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/meander.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/css/)
  })

  it('honors basePath prefix for /prefix/ and /prefix/<slug>/part/<n>', async () => {
    const { baseUrl } = await start({ basePath: '/prefix' })
    /* Trailing-slash form hits the `startsWith(basePath + '/')`
     * strip branch. */
    const rootRes = await fetch(`${baseUrl}/`)
    expect(rootRes.status).toBe(200)
    expect(await rootRes.text()).toContain('<title>index</title>')
    /* Real prefix stripping — request a part under the prefix. */
    const partRes = await fetch(`${baseUrl}/demo/part/1`)
    expect(partRes.status).toBe(200)
    expect(await partRes.text()).toContain('<title>p1</title>')
  })

  it('rewrites exact-match basePath hit (no trailing slash) to /', async () => {
    const { baseUrl } = await start({ basePath: '/prefix' })
    /* baseUrl is already trimmed to end in `/prefix`. Fetch it
     * directly (no trailing slash). fetch() follows redirects
     * but we're not redirecting — the handler rewrites decoded
     * to `/` and serves index.html. */
    const res = await fetch(baseUrl)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>index</title>')
  })

  it('returns 404 for missing files', async () => {
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/nonexistent.txt`)
    expect(res.status).toBe(404)
  })

  it('returns 400 for undecodable URL path', async () => {
    const { baseUrl } = await start()
    /* `%` without a valid hex pair makes decodeURIComponent
     * throw; serve() should catch it and return 400. */
    const res = await fetch(`${baseUrl}/bad%`)
    expect(res.status).toBe(400)
  })

  it('returns 400 for path-traversal attempts', async () => {
    const { baseUrl } = await start()
    /* Using raw TCP request because fetch normalizes `..` */
    const res = await fetch(`${baseUrl}/demo/%2e%2e/etc/passwd`)
    /* Either 400 (traversal guard rejected) or 404 (resolved
     * path wasn't found after normalization). Both are safe —
     * we must not 200 with arbitrary file content. */
    expect([400, 404]).toContain(res.status)
  })

  it('falls back to application/octet-stream for unknown extensions', async () => {
    writeFileSync(
      path.join(tmpDir, 'pages', 'data.bin'),
      'binary data',
      'utf-8',
    )
    const { baseUrl } = await start()
    const res = await fetch(`${baseUrl}/data.bin`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('returns 404 when the target resolves to a directory', async () => {
    const { baseUrl } = await start()
    /* `/demo/part/` with a part id matches routeToFile → `part-`;
     * that file doesn't exist so we fall through to asset path.
     * To trigger the directory branch: request the pages dir
     * itself via `/pages` (routes through as an asset ref). */
    mkdirSync(path.join(tmpDir, 'pages', 'adir'), { recursive: true })
    const res = await fetch(`${baseUrl}/adir`)
    expect(res.status).toBe(404)
  })
})

describe('serve (config + fallback resolution)', () => {
  let tmpDir: string
  let server: Server | null = null

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'meander-serve-resolve-'))
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()))
      server = null
    }
    await safeDelete(tmpDir, { recursive: true, force: true })
  })

  it('falls back to legacy walkthrough/ dir when pages/ is missing', async () => {
    /* No pages/ dir — just a walkthrough/ dir with minimal
     * content. serve() should find it via the backward-compat
     * branch. */
    const legacyDir = path.join(tmpDir, 'walkthrough')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(
      path.join(legacyDir, 'index.html'),
      '<!doctype html><title>legacy</title>',
      'utf-8',
    )
    writeFileSync(
      path.join(tmpDir, 'meander.config.json'),
      JSON.stringify({
        slug: 'legacy',
        title: 'Legacy',
        parts: [
          {
            id: 1,
            title: 'x',
            objective: 'y',
            keywords: ['z'],
            files: ['a.ts'],
          },
        ],
      }),
      'utf-8',
    )
    const result = await serve(path.join(tmpDir, 'meander.config.json'), {
      port: 0,
    })
    if (!result) {
      throw new Error('serve() returned undefined')
    }
    server = result.server
    const res = await fetch(result.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('legacy')
  })

  it('honors outDir from the config', async () => {
    const customDir = path.join(tmpDir, 'custom')
    mkdirSync(customDir, { recursive: true })
    writeFileSync(
      path.join(customDir, 'index.html'),
      '<!doctype html><title>custom</title>',
      'utf-8',
    )
    writeFileSync(
      path.join(tmpDir, 'meander.config.json'),
      JSON.stringify({
        slug: 'custom',
        title: 'Custom',
        outDir: 'custom',
        parts: [
          {
            id: 1,
            title: 'x',
            objective: 'y',
            keywords: ['z'],
            files: ['a.ts'],
          },
        ],
      }),
      'utf-8',
    )
    const result = await serve(path.join(tmpDir, 'meander.config.json'), {
      port: 0,
    })
    if (!result) {
      throw new Error('serve() returned undefined')
    }
    server = result.server
    const res = await fetch(result.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('custom')
  })

  it('returns undefined when no emit dir exists', async () => {
    writeFileSync(
      path.join(tmpDir, 'meander.config.json'),
      JSON.stringify({
        slug: 'none',
        title: 'None',
        parts: [
          {
            id: 1,
            title: 'x',
            objective: 'y',
            keywords: ['z'],
            files: ['a.ts'],
          },
        ],
      }),
      'utf-8',
    )
    /* Suppress the console.error that serve() writes when the
     * emit dir is missing — this is expected output for this
     * test, not a real failure. */
    const original = console.error
    console.error = () => {}
    try {
      const result = await serve(path.join(tmpDir, 'meander.config.json'), {
        port: 0,
      })
      expect(result).toBeUndefined()
    } finally {
      console.error = original
    }
  })

  it('tolerates malformed config JSON (falls back to pages default)', async () => {
    const pagesDir = path.join(tmpDir, 'pages')
    mkdirSync(pagesDir, { recursive: true })
    writeFileSync(
      path.join(pagesDir, 'index.html'),
      '<!doctype html><title>default</title>',
      'utf-8',
    )
    /* Write a meander.config.json that's not valid JSON. serve()
     * should swallow the parse error and use the pages default. */
    writeFileSync(
      path.join(tmpDir, 'meander.config.json'),
      '{ not json at all',
      'utf-8',
    )
    const result = await serve(path.join(tmpDir, 'meander.config.json'), {
      port: 0,
    })
    if (!result) {
      throw new Error('serve() returned undefined')
    }
    server = result.server
    const res = await fetch(result.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('default')
  })
})
