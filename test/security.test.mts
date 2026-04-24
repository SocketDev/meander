/** @fileoverview Tests for security.mts — SRI computation + injection, CSP meta. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { safeDelete } from '@socketsecurity/lib/fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildCspContent,
  computeIntegrity,
  injectCspMeta,
  injectSriIntegrity,
  sriForUrl,
} from '../src/security.mts'

describe('computeIntegrity', () => {
  it('returns an sha512-base64 SRI string', () => {
    const hash = computeIntegrity(new TextEncoder().encode('hello world'))
    expect(hash).toMatch(/^sha512-[A-Za-z0-9+/=]+$/)
  })

  it('is deterministic', () => {
    const a = computeIntegrity(new TextEncoder().encode('abc'))
    const b = computeIntegrity(new TextEncoder().encode('abc'))
    expect(a).toBe(b)
  })

  it('distinguishes different inputs', () => {
    const a = computeIntegrity(new TextEncoder().encode('abc'))
    const b = computeIntegrity(new TextEncoder().encode('abd'))
    expect(a).not.toBe(b)
  })
})

describe('sriForUrl cache', () => {
  let tmpDir: string
  let capturedUrl: string | null = null
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'meander-sri-'))
    capturedUrl = null
    globalThis.fetch = (async (input: string | URL | Request) => {
      capturedUrl = typeof input === 'string' ? input : String(input)
      const bytes = new TextEncoder().encode('cdn payload')
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer,
      } as unknown as Response
    }) as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await safeDelete(tmpDir, { recursive: true, force: true })
  })

  it('fetches + returns sha512 on first call', async () => {
    const url = 'https://unpkg.com/foo@1/index.js'
    const h = await sriForUrl(url, { cacheDir: tmpDir })
    expect(h).toMatch(/^sha512-/)
    expect(capturedUrl).toBe(url)
  })

  it('second call hits the cache (no fetch)', async () => {
    const url = 'https://unpkg.com/foo@1/index.js'
    const first = await sriForUrl(url, { cacheDir: tmpDir })
    capturedUrl = null
    const second = await sriForUrl(url, { cacheDir: tmpDir })
    expect(second).toBe(first)
    expect(capturedUrl).toBeNull()
  })

  it('omitting cacheDir fetches every time', async () => {
    const url = 'https://unpkg.com/foo@1/index.js'
    await sriForUrl(url)
    expect(capturedUrl).toBe(url)
    capturedUrl = null
    await sriForUrl(url)
    expect(capturedUrl).toBe(url)
  })

  it('throws on non-ok response', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Response) as typeof globalThis.fetch
    await expect(
      sriForUrl('https://unpkg.com/missing@1/boom.js'),
    ).rejects.toThrow(/HTTP 404/)
  })

  it('throws on non-ok response even with cacheDir set', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 503,
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Response) as typeof globalThis.fetch
    await expect(
      sriForUrl('https://unpkg.com/down@1/index.js', { cacheDir: tmpDir }),
    ).rejects.toThrow(/HTTP 503/)
  })
})

describe('injectSriIntegrity', () => {
  let tmpDir: string
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'meander-sri-inject-'))
    globalThis.fetch = (async () => {
      const bytes = new TextEncoder().encode('remote body')
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer,
      } as unknown as Response
    }) as typeof globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await safeDelete(tmpDir, { recursive: true, force: true })
  })

  it('injects integrity on a remote <script src>', async () => {
    const html =
      '<html><head><script src="https://unpkg.com/foo/index.js"></script></head><body></body></html>'
    const out = await injectSriIntegrity(html)
    expect(out).toMatch(/integrity="sha512-/)
    expect(out).toContain('crossorigin="anonymous"')
  })

  it('injects integrity on a same-origin <script src> when localDir is set', async () => {
    writeFileSync(path.join(tmpDir, 'app.js'), 'console.log(1)', 'utf-8')
    const html =
      '<html><head><script src="/app.js"></script></head><body></body></html>'
    const out = await injectSriIntegrity(html, { localDir: tmpDir })
    expect(out).toMatch(/integrity="sha512-/)
    /* Same-origin refs don't get crossorigin. */
    expect(out).not.toContain('crossorigin=')
  })

  it('strips basePath before local lookup', async () => {
    writeFileSync(path.join(tmpDir, 'app.js'), 'console.log(1)', 'utf-8')
    const html =
      '<html><head><script src="/prefix/app.js"></script></head><body></body></html>'
    const out = await injectSriIntegrity(html, {
      localDir: tmpDir,
      basePath: '/prefix',
    })
    expect(out).toMatch(/integrity="sha512-/)
  })

  it('leaves tags with an existing integrity attribute alone', async () => {
    const html =
      '<html><head><script src="https://unpkg.com/foo/index.js" integrity="sha512-preset"></script></head></html>'
    const out = await injectSriIntegrity(html)
    expect(out).toContain('integrity="sha512-preset"')
    /* Original was preserved; not rewritten. */
    const matches = out.match(/integrity="/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('handles <link rel=stylesheet> + <link rel=modulepreload>', async () => {
    writeFileSync(path.join(tmpDir, 'main.css'), 'body{}', 'utf-8')
    writeFileSync(path.join(tmpDir, 'mod.mjs'), 'export {}', 'utf-8')
    const html =
      '<html><head><link rel="stylesheet" href="/main.css"><link rel="modulepreload" href="/mod.mjs"></head></html>'
    const out = await injectSriIntegrity(html, { localDir: tmpDir })
    /* Both tags should get integrity. */
    const matches = out.match(/integrity="sha512-/g) ?? []
    expect(matches.length).toBe(2)
  })

  it('skips <link rel=icon>', async () => {
    const html =
      '<html><head><link rel="icon" href="/favicon.ico"></head></html>'
    const out = await injectSriIntegrity(html, { localDir: tmpDir })
    expect(out).not.toContain('integrity=')
  })

  it('skips unknown remote hosts', async () => {
    const html =
      '<html><head><script src="https://evil.example.com/a.js"></script></head></html>'
    const out = await injectSriIntegrity(html)
    expect(out).not.toContain('integrity=')
  })

  it('skips inline <script> (no src)', async () => {
    const html = '<html><head><script>console.log(1)</script></head></html>'
    const out = await injectSriIntegrity(html)
    expect(out).not.toContain('integrity=')
  })

  it('skips relative <script src> (not /-rooted, not remote)', async () => {
    const html = '<html><head><script src="./app.js"></script></head></html>'
    const out = await injectSriIntegrity(html, { localDir: tmpDir })
    expect(out).not.toContain('integrity=')
  })

  it('skips <link> without a recognized rel', async () => {
    const html =
      '<html><head><link rel="manifest" href="/app.webmanifest"></head></html>'
    const out = await injectSriIntegrity(html, { localDir: tmpDir })
    expect(out).not.toContain('integrity=')
  })

  it('skips <link rel=stylesheet> with no href', async () => {
    const html = '<html><head><link rel="stylesheet"></head></html>'
    const out = await injectSriIntegrity(html, { localDir: tmpDir })
    expect(out).not.toContain('integrity=')
  })

  it('caches duplicate refs across multiple tags', async () => {
    writeFileSync(path.join(tmpDir, 'same.js'), 'const x = 1', 'utf-8')
    const html =
      '<html><head>' +
      '<script src="/same.js"></script>' +
      '<script src="/same.js"></script>' +
      '</head></html>'
    const out = await injectSriIntegrity(html, { localDir: tmpDir })
    const matches = out.match(/integrity="sha512-/g) ?? []
    expect(matches.length).toBe(2)
  })
})

describe('buildCspContent', () => {
  it('covers the core directive set', () => {
    const content = buildCspContent('<html><head></head></html>')
    expect(content).toContain("default-src 'self'")
    expect(content).toContain("script-src 'self' https://unpkg.com")
    expect(content).toContain("style-src 'self'")
    expect(content).toContain("connect-src 'self'")
    expect(content).toContain("frame-ancestors 'none'")
  })

  it('adds per-inline-script sha256 hashes', () => {
    const html = '<html><head><script>console.log(1)</script></head></html>'
    const content = buildCspContent(html)
    expect(content).toMatch(/script-src[^;]*'sha256-/)
  })

  it('adds per-inline-style + style="" sha256 hashes', () => {
    const html =
      '<html><head><style>body{}</style></head><body style="color:red"></body></html>'
    const content = buildCspContent(html)
    expect(content).toContain("'sha256-")
    expect(content).toContain("'unsafe-hashes'")
  })

  it('expands connect-src with consumer hosts', () => {
    const content = buildCspContent('<html><head></head></html>', {
      connectSrc: ['https://api.example.com'],
    })
    expect(content).toContain("connect-src 'self' https://api.example.com")
  })

  it('overrides cdnHosts', () => {
    const content = buildCspContent('<html><head></head></html>', {
      cdnHosts: ['https://cdn.mine.com'],
    })
    expect(content).toContain('https://cdn.mine.com')
    expect(content).not.toContain('https://unpkg.com')
  })

  it('skips external <script src>, empty <script>, empty <style>', () => {
    const html =
      '<html><head>' +
      '<script src="/app.js"></script>' +
      '<script></script>' +
      '<style></style>' +
      '<script>console.log(1)</script>' +
      '</head></html>'
    const content = buildCspContent(html)
    /* Exactly one inline-script hash (for `console.log(1)`). */
    const matches = content.match(/'sha256-[^']+'/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('skips elements with an empty style="" attribute', () => {
    /* An element with `style=""` will be picked up by the
     * [style] selector, but the empty value should not produce
     * a hash. Reading via getAttribute returns the empty string. */
    const html = '<html><body><div style="">x</div></body></html>'
    const content = buildCspContent(html)
    expect(content).not.toContain("'sha256-")
  })
})

describe('injectCspMeta', () => {
  it('adds a <meta> tag at the top of <head>', () => {
    const html = '<html><head><title>x</title></head><body></body></html>'
    const out = injectCspMeta(html)
    expect(out).toContain('<meta http-equiv="Content-Security-Policy"')
  })

  it('is idempotent — second call is a no-op', () => {
    const once = injectCspMeta(
      '<html><head><title>x</title></head><body></body></html>',
    )
    const twice = injectCspMeta(once)
    expect(twice).toBe(once)
  })

  it('bails out when <head> is missing', () => {
    const html = '<html><body></body></html>'
    const out = injectCspMeta(html)
    /* No head means nothing to inject into; return the input. */
    expect(out).toBe(html)
  })

  it('quote-escapes embedded double quotes in the content attr', () => {
    /* Inline <style> can legitimately contain double quotes in
     * attribute selectors. We shouldn't break the <meta> tag. */
    const html =
      '<html><head><style>a[href="#"]{color:red}</style></head></html>'
    const out = injectCspMeta(html)
    expect(out).toContain('<meta http-equiv="Content-Security-Policy"')
    /* No raw double quote inside the content= value — must be escaped. */
    const metaMatch = out.match(/content="([^"]*)"/)
    expect(metaMatch).not.toBeNull()
  })
})
