/**
 * @fileoverview Tests for src/ceremony-deps.mts.
 *
 * The ceremony test files exercise gatherShares + printShares
 * indirectly via dbKeyInit/Rotate/etc. This file covers the
 * surface those don't reach: the production factories
 * (createEnvClient / createAdminClient / createIoChannel),
 * the pure helpers (bytesToHex / hexToBytes /
 * validateShamirParams), and the standalone behavior of
 * gatherShares + printShares against the FakeIo channel.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bytesToHex,
  createAdminClient,
  createEnvClient,
  createIoChannel,
  gatherShares,
  hexToBytes,
  printShares,
  validateShamirParams,
} from '../src/ceremony-deps.mts'
import { encodeShare, split } from '../src/shamir.mts'
import { FakeIo } from './utils/fake-deps.mts'

afterEach(() => {
  vi.restoreAllMocks()
})

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe('bytesToHex / hexToBytes', () => {
  it('round-trips a 32-byte buffer', () => {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      bytes[i] = i
    }
    const hex = bytesToHex(bytes)
    expect(hex).toBe(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    )
    expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes))
  })

  it('zero-pads single-digit bytes', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 0xff]))).toBe('0001ff')
  })

  it('hexToBytes accepts uppercase + lowercase', () => {
    const lower = '00'.repeat(32)
    const upper = lower.toUpperCase()
    expect(Array.from(hexToBytes(lower))).toEqual(Array.from(hexToBytes(upper)))
  })

  it('hexToBytes rejects wrong length', () => {
    expect(() => hexToBytes('00')).toThrow(/64 hex/)
    expect(() => hexToBytes('00'.repeat(31) + '0')).toThrow(/64 hex/)
  })

  it('hexToBytes rejects non-hex characters', () => {
    expect(() => hexToBytes('z'.repeat(64))).toThrow(/64 hex/)
  })
})

describe('validateShamirParams', () => {
  it('accepts the default 2-of-3', () => {
    expect(() => validateShamirParams(2, 3)).not.toThrow()
  })

  it('accepts 3-of-5', () => {
    expect(() => validateShamirParams(3, 5)).not.toThrow()
  })

  it('accepts 4-of-7', () => {
    expect(() => validateShamirParams(4, 7)).not.toThrow()
  })

  it('rejects threshold < 2', () => {
    expect(() => validateShamirParams(1, 3)).toThrow(/threshold/)
    expect(() => validateShamirParams(0, 3)).toThrow(/threshold/)
  })

  it('rejects shares < threshold', () => {
    expect(() => validateShamirParams(3, 2)).toThrow(/shares/)
  })

  it('rejects shares > 255', () => {
    expect(() => validateShamirParams(2, 256)).toThrow(/255/)
  })

  it('rejects non-integer values', () => {
    expect(() => validateShamirParams(2.5, 3)).toThrow(/integer/)
    expect(() => validateShamirParams(2, 3.7)).toThrow(/integer/)
  })

  it('rejects NaN', () => {
    expect(() => validateShamirParams(Number.NaN, 3)).toThrow(/integer/)
    expect(() => validateShamirParams(2, Number.NaN)).toThrow(/integer/)
  })
})

/* ------------------------------------------------------------------ */
/*  gatherShares + printShares (pure functions over IoChannel)         */
/* ------------------------------------------------------------------ */

describe('gatherShares', () => {
  it('reads `threshold` shares through the IO channel and decodes each', async () => {
    const fixture = split(new Uint8Array(Buffer.alloc(32, 0x42)), 2, 3)
    const encoded = fixture.slice(0, 2).map(encodeShare)
    const io = new FakeIo(encoded)
    const out = await gatherShares(io, 2)
    expect(out).toHaveLength(2)
    /* Each returned Uint8Array equals the original share's bytes. */
    expect(Array.from(out[0]!)).toEqual(Array.from(fixture[0]!))
    expect(Array.from(out[1]!)).toEqual(Array.from(fixture[1]!))
  })

  it('propagates an exhausted IoChannel as a clear error', async () => {
    const io = new FakeIo([]) // no shares queued
    await expect(gatherShares(io, 2)).rejects.toThrow(
      /no more shares queued/,
    )
  })
})

describe('printShares', () => {
  it('emits the comment-store footer for db-key context', () => {
    const io = new FakeIo()
    const shares = split(new Uint8Array(Buffer.alloc(32, 0x99)), 2, 3)
    printShares(io, shares, 2, 'comment-store')
    expect(io.text()).toContain('Share 1 of 3:')
    expect(io.text()).toContain('Share 2 of 3:')
    expect(io.text()).toContain('Share 3 of 3:')
    expect(io.text()).toContain('comment store is unreadable')
    expect(io.text()).not.toContain('encrypted blobs')
  })

  it('emits the blobs footer for blob-key context', () => {
    const io = new FakeIo()
    const shares = split(new Uint8Array(Buffer.alloc(32, 0x99)), 3, 5)
    printShares(io, shares, 3, 'blobs')
    expect(io.text()).toContain('encrypted blobs')
    expect(io.text()).toContain('Re-publishing all blobs')
    expect(io.text()).not.toContain('comment store is unreadable')
  })

  it('preserves share ordering in the output', () => {
    const io = new FakeIo()
    const shares = split(new Uint8Array(Buffer.alloc(32, 0xde)), 2, 3)
    printShares(io, shares, 2, 'comment-store')
    /* The output should contain "Share 1 of 3" before
     * "Share 2 of 3" before "Share 3 of 3". */
    const idx1 = io.text().indexOf('Share 1 of 3')
    const idx2 = io.text().indexOf('Share 2 of 3')
    const idx3 = io.text().indexOf('Share 3 of 3')
    expect(idx1).toBeGreaterThan(0)
    expect(idx2).toBeGreaterThan(idx1)
    expect(idx3).toBeGreaterThan(idx2)
  })
})

/* ------------------------------------------------------------------ */
/*  createEnvClient — bound wrapper over valtown-env free functions    */
/* ------------------------------------------------------------------ */

describe('createEnvClient', () => {
  it('binds token + valId into every method', async () => {
    const seen: Array<{ url: string; auth: string | null; method: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers ?? {})
      seen.push({
        url: typeof input === 'string' ? input : input.toString(),
        auth: headers.get('authorization'),
        method: (init?.method ?? 'GET').toUpperCase(),
      })
      /* Return shapes the production callers expect. */
      if (init?.method === 'DELETE') {
        return new Response('', { status: 200 })
      }
      if (init?.method === 'PUT') {
        return new Response('', { status: 200 })
      }
      return new Response(JSON.stringify({ data: [], value: 'v' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const env = createEnvClient('tok-xyz', 'val-id-42')
    await env.getEnvVar('FOO')
    await env.setEnvVar('BAR', 'v')
    await env.listEnvVarNames()
    await env.deleteEnvVar('OLD')
    /* Every call carries Bearer tok-xyz and references val-id-42. */
    expect(seen).toHaveLength(4)
    for (const s of seen) {
      expect(s.auth).toBe('Bearer tok-xyz')
      expect(s.url).toContain('/v2/vals/val-id-42/environment_variables')
    }
  })
})

/* ------------------------------------------------------------------ */
/*  createAdminClient — bound /admin/* client                          */
/* ------------------------------------------------------------------ */

describe('createAdminClient', () => {
  it('keyAudit GETs /admin/key-audit with Bearer token', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers ?? {})
      seen.push({
        url: typeof input === 'string' ? input : input.toString(),
        auth: headers.get('authorization'),
      })
      return new Response(
        JSON.stringify({
          visibleGenerations: [1],
          currentGeneration: 1,
          rowCounts: { '1': 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const admin = createAdminClient(
      'https://my-val.web.val.run',
      'admin-tok',
    )
    const result = await admin.keyAudit()
    expect(result.currentGeneration).toBe(1)
    expect(result.rowCounts).toEqual({ '1': 5 })
    expect(seen[0]!.url).toBe('https://my-val.web.val.run/admin/key-audit')
    expect(seen[0]!.auth).toBe('Bearer admin-tok')
  })

  it('keyAudit throws on non-OK status', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('boom', { status: 500 })
    })
    const admin = createAdminClient('https://x.web.val.run', 'admin-tok')
    await expect(admin.keyAudit()).rejects.toThrow(/audit failed.*500/)
  })

  it('rewrap POSTs JSON with the request body', async () => {
    const seen: Array<{ method: string; body: string | undefined }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seen.push({
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      return new Response(
        JSON.stringify({ rewrapped: 7, remaining: 3 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const admin = createAdminClient('https://x.web.val.run', 'admin-tok')
    const result = await admin.rewrap({
      fromGeneration: 1,
      toGeneration: 2,
      batchSize: 50,
    })
    expect(result).toEqual({ rewrapped: 7, remaining: 3 })
    expect(seen[0]!.method).toBe('POST')
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      fromGeneration: 1,
      toGeneration: 2,
      batchSize: 50,
    })
  })

  it('rewrap defaults batchSize to 100 when not provided', async () => {
    let seenBody: string | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      seenBody = typeof init?.body === 'string' ? init.body : undefined
      return new Response(JSON.stringify({ rewrapped: 0, remaining: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const admin = createAdminClient('https://x.web.val.run', 'admin-tok')
    await admin.rewrap({ fromGeneration: 1, toGeneration: 2 })
    expect(JSON.parse(seenBody!)).toEqual({
      fromGeneration: 1,
      toGeneration: 2,
      batchSize: 100,
    })
  })

  it('rewrap throws on non-OK status', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('nope', { status: 400 })
    })
    const admin = createAdminClient('https://x.web.val.run', 'admin-tok')
    await expect(
      admin.rewrap({ fromGeneration: 1, toGeneration: 2 }),
    ).rejects.toThrow(/rewrap failed.*400/)
  })
})

/* ------------------------------------------------------------------ */
/*  createIoChannel — file-driven share queue + readline fallback      */
/* ------------------------------------------------------------------ */

describe('createIoChannel', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'meander-iochannel-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('reads queued shares from --share-file paths in order', async () => {
    const a = path.join(tmp, 'share-a.txt')
    const b = path.join(tmp, 'share-b.txt')
    writeFileSync(a, 'first-share\n')
    writeFileSync(b, '  second-share  \n')
    const io = createIoChannel([a, b])
    expect(await io.readShare('ignored')).toBe('first-share')
    expect(await io.readShare('ignored')).toBe('second-share')
  })

  it('throws when a --share-file path does not exist', () => {
    const missing = path.join(tmp, 'nope.txt')
    expect(() => createIoChannel([missing])).toThrow(/not found/)
  })

  it('throws when a --share-file is empty', () => {
    const empty = path.join(tmp, 'empty.txt')
    writeFileSync(empty, '   \n  \n')
    expect(() => createIoChannel([empty])).toThrow(/empty/)
  })

  it('printLine writes via console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const io = createIoChannel([])
    io.printLine('hello')
    io.printLine('world')
    expect(spy).toHaveBeenCalledWith('hello')
    expect(spy).toHaveBeenCalledWith('world')
  })

  /* The interactive readline branch is exercised by a separate
   * test file (test/ceremony-deps-readline.test.mts) that
   * vi.mock()s `node:readline/promises` at module scope. ESM
   * namespaces can't be patched after import, so the mock has
   * to live in its own file with hoisted vi.mock(). */
})

/* ------------------------------------------------------------------ */
/*  createDefaultDeps — bundle factory                                 */
/* ------------------------------------------------------------------ */

describe('createDefaultDeps', () => {
  it('returns a struct with all four CeremonyDeps fields wired', async () => {
    const fresh = await import('../src/ceremony-deps.mts')
    const deps = fresh.createDefaultDeps(
      'tok',
      {
        id: 'val-id',
        username: 'alice',
        url: 'https://alice-walkthrough.web.val.run',
      },
      'admin-tok',
      [],
    )
    expect(typeof deps.env.getEnvVar).toBe('function')
    expect(typeof deps.env.setEnvVar).toBe('function')
    expect(typeof deps.admin.keyAudit).toBe('function')
    expect(typeof deps.admin.rewrap).toBe('function')
    expect(typeof deps.io.readShare).toBe('function')
    expect(typeof deps.io.printLine).toBe('function')
    /* randomWrappingKey returns a 32-byte buffer. */
    const key = deps.randomWrappingKey()
    expect(key.length).toBe(32)
  })
})
