/**
 * @fileoverview Tests for src/blob-key.mts ceremony commands.
 *
 * Same shape as test/db-key.test.mts — fakes from
 * test/utils/fake-deps.mts drive the ceremony functions end-to-end.
 */

import { describe, expect, it } from 'vitest'

import {
  blobKeyInit,
  blobKeyRestore,
  blobKeyRotate,
  blobKeyShow,
} from '../src/blob-key.mts'
import { encodeShare, split } from '../src/shamir.mts'
import { fixedKey, makeDeps } from './utils/fake-deps.mts'

const KEY_OF_BYTE = (b: number) => Buffer.alloc(32, b)
const HEX_OF_BYTE = (b: number) => b.toString(16).padStart(2, '0').repeat(32)

/* ------------------------------------------------------------------ */
/*  init                                                                */
/* ------------------------------------------------------------------ */

describe('blobKeyInit', () => {
  it('plants MEANDER_BLOB_KEY and prints shares + a shell snippet', async () => {
    const deps = makeDeps({ randomWrappingKey: fixedKey(0xa1) })
    await blobKeyInit({ threshold: 2, shares: 3 }, deps)

    expect(deps.env.store.get('MEANDER_BLOB_KEY')).toBe(HEX_OF_BYTE(0xa1))
    expect(deps.io.text()).toContain('Share 1 of 3:')
    expect(deps.io.text()).toContain('encrypted blobs')
    expect(deps.io.text()).toContain('export MEANDER_BLOB_KEY=')
  })

  it('refuses when MEANDER_BLOB_KEY is already set', async () => {
    const deps = makeDeps({
      envInitial: { MEANDER_BLOB_KEY: HEX_OF_BYTE(0x11) },
    })
    await expect(blobKeyInit({}, deps)).rejects.toThrow(/already set/)
  })

  it('rejects threshold < 2', async () => {
    const deps = makeDeps()
    await expect(
      blobKeyInit({ threshold: 1, shares: 3 }, deps),
    ).rejects.toThrow(/threshold/)
  })

  it('rejects shares < threshold', async () => {
    const deps = makeDeps()
    await expect(
      blobKeyInit({ threshold: 3, shares: 2 }, deps),
    ).rejects.toThrow(/shares/)
  })
})

/* ------------------------------------------------------------------ */
/*  rotate                                                              */
/* ------------------------------------------------------------------ */

describe('blobKeyRotate', () => {
  it('replaces MEANDER_BLOB_KEY when shares match', async () => {
    const oldShares = split(new Uint8Array(KEY_OF_BYTE(0x77)), 2, 3)
      .slice(0, 2)
      .map(encodeShare)
    const deps = makeDeps({
      envInitial: { MEANDER_BLOB_KEY: HEX_OF_BYTE(0x77) },
      shares: oldShares,
      randomWrappingKey: fixedKey(0xee),
    })
    await blobKeyRotate({ threshold: 2, shares: 3 }, deps)
    expect(deps.env.store.get('MEANDER_BLOB_KEY')).toBe(HEX_OF_BYTE(0xee))
    /* Output prompts the operator to re-publish — without that
     * step the val's blobs become unreadable. */
    expect(deps.io.text()).toContain('meander publish')
    expect(deps.io.text()).toContain('every existing encrypted blob is unreadable')
  })

  it('refuses when MEANDER_BLOB_KEY is not set', async () => {
    const deps = makeDeps({
      shares: split(new Uint8Array(KEY_OF_BYTE(0x99)), 2, 3)
        .slice(0, 2)
        .map(encodeShare),
    })
    await expect(blobKeyRotate({}, deps)).rejects.toThrow(/init/)
  })

  it('refuses when reconstructed shares do not match the env key', async () => {
    /* Env says 0xaa, shares reconstruct 0xbb. */
    const wrongShares = split(new Uint8Array(KEY_OF_BYTE(0xbb)), 2, 3)
      .slice(0, 2)
      .map(encodeShare)
    const deps = makeDeps({
      envInitial: { MEANDER_BLOB_KEY: HEX_OF_BYTE(0xaa) },
      shares: wrongShares,
    })
    await expect(
      blobKeyRotate({ threshold: 2, shares: 3 }, deps),
    ).rejects.toThrow(/does not match/)
    /* MEANDER_BLOB_KEY was not mutated. */
    expect(deps.env.store.get('MEANDER_BLOB_KEY')).toBe(HEX_OF_BYTE(0xaa))
  })
})

/* ------------------------------------------------------------------ */
/*  restore                                                             */
/* ------------------------------------------------------------------ */

describe('blobKeyRestore', () => {
  it('plants MEANDER_BLOB_KEY when env is empty', async () => {
    const deps = makeDeps({
      shares: split(new Uint8Array(KEY_OF_BYTE(0x55)), 2, 3)
        .slice(0, 2)
        .map(encodeShare),
    })
    await blobKeyRestore({ threshold: 2 }, deps)
    expect(deps.env.store.get('MEANDER_BLOB_KEY')).toBe(HEX_OF_BYTE(0x55))
    expect(deps.io.text()).toContain('export MEANDER_BLOB_KEY=')
  })

  it('no-ops when shares match the existing key', async () => {
    const deps = makeDeps({
      envInitial: { MEANDER_BLOB_KEY: HEX_OF_BYTE(0x33) },
      shares: split(new Uint8Array(KEY_OF_BYTE(0x33)), 2, 3)
        .slice(0, 2)
        .map(encodeShare),
    })
    await blobKeyRestore({ threshold: 2 }, deps)
    expect(deps.io.text()).toContain('nothing to restore')
    expect(deps.env.store.size).toBe(1)
  })

  it('refuses when env has a different key already (use rotate, not restore)', async () => {
    const deps = makeDeps({
      envInitial: { MEANDER_BLOB_KEY: HEX_OF_BYTE(0x11) },
      shares: split(new Uint8Array(KEY_OF_BYTE(0x22)), 2, 3)
        .slice(0, 2)
        .map(encodeShare),
    })
    await expect(
      blobKeyRestore({ threshold: 2 }, deps),
    ).rejects.toThrow(/already set to a different value/)
  })
})

/* ------------------------------------------------------------------ */
/*  show                                                                */
/* ------------------------------------------------------------------ */

describe('blobKeyShow', () => {
  it('prints the current MEANDER_BLOB_KEY (no labels)', async () => {
    const deps = makeDeps({
      envInitial: { MEANDER_BLOB_KEY: HEX_OF_BYTE(0xab) },
    })
    await blobKeyShow(deps)
    /* Single line, just the hex. The "no labels" property is what
     * makes pipe-to-pbcopy work. */
    expect(deps.io.output).toEqual([HEX_OF_BYTE(0xab)])
  })

  it('refuses when MEANDER_BLOB_KEY is not set', async () => {
    const deps = makeDeps()
    await expect(blobKeyShow(deps)).rejects.toThrow(/init/)
  })
})
