/**
 * @file Tests for src/ceremony-deps.mts.
 *   The ceremony test files exercise gatherShares + printShares
 *   indirectly via dbKeyInit/Rotate/etc. This file covers the
 *   surface those don't reach: the production factories
 *   (createEnvClient / createAdminClient / createIoChannel),
 *   the pure helpers (bytesToHex / hexToBytes /
 *   validateShamirParams), and the standalone behavior of
 *   gatherShares + printShares against the FakeIo channel.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import nock from 'nock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// oxlint-disable-next-line socket/no-src-import-in-test-expect -- @socketsecurity/meander is not yet published; no -stable alias exists, so the src/ import is required. Revisit after first publish.
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
import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'

const VAL_API = 'https://api.val.town'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
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
  it.each([
    [2, 3],
    [3, 5],
    [4, 7],
    [2, 255],
  ])('accepts %d-of-%d', (threshold, shares) => {
    expect(() => validateShamirParams(threshold, shares)).not.toThrow()
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
    await expect(gatherShares(io, 2)).rejects.toThrow(/no more shares queued/)
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
    /* Each interceptor pins the exact per-method URL under
     * /v2/vals/val-id-42/... and requires `Bearer tok-xyz`; nock
     * only matches when both hold, so scope.isDone() proves every
     * call carried the bound token + valId. */
    const envPath = '/v2/vals/val-id-42/environment_variables'
    const scope = nock(VAL_API)
      .matchHeader('authorization', 'Bearer tok-xyz')
      .get(`${envPath}/FOO`)
      .reply(200, { value: 'v' })
      .put(`${envPath}/BAR`)
      .reply(200, '')
      .get(envPath)
      .reply(200, { data: [] })
      .delete(`${envPath}/OLD`)
      .reply(200, '')
    const env = createEnvClient('tok-xyz', 'val-id-42')
    await env.getEnvVar('FOO')
    await env.setEnvVar('BAR', 'v')
    await env.listEnvVarNames()
    await env.deleteEnvVar('OLD')
    expect(scope.isDone()).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  createAdminClient — bound /admin/* client                          */
/* ------------------------------------------------------------------ */

describe('createAdminClient', () => {
  it('keyAudit GETs /admin/key-audit with Bearer token', async () => {
    /* The interceptor's path pins the URL and matchHeader pins the
     * Bearer token — nock only replies when both match, so a green
     * result + isDone() proves the request shape. */
    const scope = nock('https://my-val.web.val.run')
      .get('/admin/key-audit')
      .matchHeader('authorization', 'Bearer admin-tok')
      .reply(200, {
        visibleGenerations: [1],
        currentGeneration: 1,
        rowCounts: { '1': 5 },
      })
    const admin = createAdminClient('https://my-val.web.val.run', 'admin-tok')
    const result = await admin.keyAudit()
    expect(result.currentGeneration).toBe(1)
    expect(result.rowCounts).toEqual({ '1': 5 })
    expect(scope.isDone()).toBe(true)
  })

  it('keyAudit throws on non-OK status', async () => {
    nock('https://x.web.val.run').get('/admin/key-audit').reply(500, 'boom')
    const admin = createAdminClient('https://x.web.val.run', 'admin-tok')
    await expect(admin.keyAudit()).rejects.toThrow(/audit failed.*500/)
  })

  it('rewrap POSTs JSON with the request body', async () => {
    /* The body arg makes nock match only when the POST payload
     * deep-equals it, so isDone() confirms method + body. */
    const scope = nock('https://x.web.val.run')
      .post('/admin/rewrap', {
        fromGeneration: 1,
        toGeneration: 2,
        batchSize: 50,
      })
      .reply(200, { rewrapped: 7, remaining: 3 })
    const admin = createAdminClient('https://x.web.val.run', 'admin-tok')
    const result = await admin.rewrap({
      fromGeneration: 1,
      toGeneration: 2,
      batchSize: 50,
    })
    expect(result).toEqual({ rewrapped: 7, remaining: 3 })
    expect(scope.isDone()).toBe(true)
  })

  it('rewrap defaults batchSize to 100 when not provided', async () => {
    /* batchSize omitted by the caller must be sent as 100 — the
     * body matcher fails (request unmatched) if it isn't. */
    const scope = nock('https://x.web.val.run')
      .post('/admin/rewrap', {
        fromGeneration: 1,
        toGeneration: 2,
        batchSize: 100,
      })
      .reply(200, { rewrapped: 0, remaining: 0 })
    const admin = createAdminClient('https://x.web.val.run', 'admin-tok')
    await admin.rewrap({ fromGeneration: 1, toGeneration: 2 })
    expect(scope.isDone()).toBe(true)
  })

  it('rewrap throws on non-OK status', async () => {
    nock('https://x.web.val.run').post('/admin/rewrap').reply(400, 'nope')
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
    tmp = mkdtempSync(path.join(os.tmpdir(), 'meander-iochannel-'))
  })
  afterEach(async () => {
    await safeDelete(tmp)
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
