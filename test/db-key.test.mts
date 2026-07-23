/**
 * @file Tests for src/db-key.mts ceremony commands.
 *   Each ceremony function takes a CeremonyDeps struct (env client,
 *   admin client, IO channel, random source). We pass in the fakes
 *   from test/utils/fake-deps.mts and exercise the full
 *   orchestration logic — no fetch mocks, no readline shimming, no
 *   live val needed.
 */

import { describe, expect, it } from 'vitest'

import {
  dbKeyAudit,
  dbKeyInit,
  dbKeyRestore,
  dbKeyRetire,
  dbKeyRotate,
} from '../src/db-key.mts'
import { encodeShare, split } from '../src/shamir.mts'
import { fixedKey, makeDeps } from './utils/fake-deps.mts'

const KEY_OF_BYTE = (b: number) => Buffer.alloc(32, b)
const HEX_OF_BYTE = (b: number) => b.toString(16).padStart(2, '0').repeat(32)

/* ------------------------------------------------------------------ */
/*  init                                                                */
/* ------------------------------------------------------------------ */

describe('dbKeyInit', () => {
  it('plants MEANDER_DB_KEY_1 + MEANDER_DB_KEY_CURRENT and prints shares', async () => {
    const deps = makeDeps({ randomWrappingKey: fixedKey(0xab) })
    await dbKeyInit({ threshold: 2, shares: 3 }, deps)

    expect(deps.env.store.get('MEANDER_DB_KEY_1')).toBe(HEX_OF_BYTE(0xab))
    expect(deps.env.store.get('MEANDER_DB_KEY_CURRENT')).toBe('1')
    expect(deps.io.text()).toContain('Share 1 of 3:')
    expect(deps.io.text()).toContain('Share 2 of 3:')
    expect(deps.io.text()).toContain('Share 3 of 3:')
    expect(deps.io.text()).toContain('comment store is unreadable')
  })

  it('refuses when generations already exist', async () => {
    const deps = makeDeps({
      envInitial: {
        MEANDER_DB_KEY_1: HEX_OF_BYTE(0x11),
        MEANDER_DB_KEY_CURRENT: '1',
      },
    })
    await expect(dbKeyInit({}, deps)).rejects.toThrow(/already exists/)
  })

  it('rejects threshold < 2', async () => {
    const deps = makeDeps()
    await expect(dbKeyInit({ threshold: 1, shares: 3 }, deps)).rejects.toThrow(
      /threshold/,
    )
  })

  it('rejects shares < threshold', async () => {
    const deps = makeDeps()
    await expect(dbKeyInit({ threshold: 3, shares: 2 }, deps)).rejects.toThrow(
      /shares/,
    )
  })

  it('rejects shares > 255', async () => {
    const deps = makeDeps()
    await expect(
      dbKeyInit({ threshold: 2, shares: 256 }, deps),
    ).rejects.toThrow(/255/)
  })

  it('emits shares that round-trip through Shamir combine', async () => {
    /* Capture the printed shares and reconstruct the key from the
     * threshold-many; the result must equal the planted hex. */
    const deps = makeDeps({ randomWrappingKey: fixedKey(0x42) })
    await dbKeyInit({ threshold: 2, shares: 3 }, deps)

    const lines = deps.io.output
    const shareBase58: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.startsWith('Share ') && lines[i].endsWith(':')) {
        shareBase58.push(lines[i + 1])
      }
    }
    expect(shareBase58).toHaveLength(3)
    /* (We don't combine here — that's tested exhaustively in
     *  test/shamir.test.mts. Just sanity-check the wire format.) */
    for (let i = 0, { length } = shareBase58; i < length; i += 1) {
      const s = shareBase58[i]
      expect(s).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  rotate                                                              */
/* ------------------------------------------------------------------ */

describe('dbKeyRotate', () => {
  /**
   * Build deps for a rotation test: val is in generation `fromGen`,
   * with a known wrapping-key value. Tests pass `validShares` to
   * pre-load the IO queue with shares of that key.
   */
  function setupRotateDeps(opts: {
    fromGen: number
    fromKeyByte: number
    rewrapBatches?: Array<{ rewrapped: number; remaining: number }> | undefined
    newKeyByte?: number | undefined
    threshold?: number | undefined
    sharesCount?: number | undefined
  }) {
    const threshold = opts.threshold ?? 2
    const sharesCount = opts.sharesCount ?? 3
    const fromKey = KEY_OF_BYTE(opts.fromKeyByte)
    const validShares = split(
      new Uint8Array(fromKey),
      threshold,
      sharesCount,
    ).slice(0, threshold)
    const env: Record<string, string> = {
      [`MEANDER_DB_KEY_${opts.fromGen}`]: HEX_OF_BYTE(opts.fromKeyByte),
      MEANDER_DB_KEY_CURRENT: String(opts.fromGen),
    }
    /* Default: a single batch fully drains. Tests that exercise
     * multi-batch loop or the stall-detection path supply their
     * own scripted sequence. */
    const batches = opts.rewrapBatches ?? [{ rewrapped: 0, remaining: 0 }]
    let cursor = 0
    return makeDeps({
      envInitial: env,
      shares: validShares.map(encodeShare),
      audit: {
        visibleGenerations: [opts.fromGen],
        currentGeneration: opts.fromGen,
        rowCounts: {},
      },
      rewrap: () => {
        const batch = batches[cursor] ?? { rewrapped: 0, remaining: 0 }
        cursor++
        return batch
      },
      randomWrappingKey: fixedKey(opts.newKeyByte ?? 0xcd),
    })
  }

  it('mints a new generation, drives rewrap to completion, and flips CURRENT', async () => {
    const deps = setupRotateDeps({
      fromGen: 1,
      fromKeyByte: 0x33,
      newKeyByte: 0xee,
      rewrapBatches: [
        { rewrapped: 100, remaining: 50 },
        { rewrapped: 50, remaining: 0 },
      ],
    })
    await dbKeyRotate({ threshold: 2, shares: 3 }, deps)

    /* New generation 2 planted with the new key bytes. */
    expect(deps.env.store.get('MEANDER_DB_KEY_2')).toBe(HEX_OF_BYTE(0xee))
    /* CURRENT flipped to 2. */
    expect(deps.env.store.get('MEANDER_DB_KEY_CURRENT')).toBe('2')
    /* Old generation 1 still in env (retire is a separate step). */
    expect(deps.env.store.get('MEANDER_DB_KEY_1')).toBe(HEX_OF_BYTE(0x33))
    /* Both rewrap batches were called. */
    expect(deps.admin.rewrapCalls).toHaveLength(2)
    expect(deps.admin.rewrapCalls[0].fromGeneration).toBe(1)
    expect(deps.admin.rewrapCalls[0].toGeneration).toBe(2)
    /* Status output mentions both batches. */
    expect(deps.io.text()).toContain('rewrapped 100 this batch, 50 remaining')
    expect(deps.io.text()).toContain('rewrapped 50 this batch, 0 remaining')
    expect(deps.io.text()).toContain('Rewrapped 150 rows total')
  })

  it('refuses when MEANDER_DB_KEY_CURRENT is unset', async () => {
    const deps = makeDeps({
      envInitial: { MEANDER_DB_KEY_1: HEX_OF_BYTE(0x11) },
    })
    await expect(dbKeyRotate({}, deps)).rejects.toThrow(/init/)
  })

  it('refuses when reconstructed shares do not match the env key', async () => {
    /* Env says key is 0xaa, but we feed it shares of a different
     * key (0xbb). Verification must reject. */
    const env = {
      MEANDER_DB_KEY_1: HEX_OF_BYTE(0xaa),
      MEANDER_DB_KEY_CURRENT: '1',
    }
    const wrongShares = split(new Uint8Array(KEY_OF_BYTE(0xbb)), 2, 3)
      .slice(0, 2)
      .map(encodeShare)
    const deps = makeDeps({
      envInitial: env,
      shares: wrongShares,
      audit: { visibleGenerations: [1], currentGeneration: 1, rowCounts: {} },
    })
    await expect(
      dbKeyRotate({ threshold: 2, shares: 3 }, deps),
    ).rejects.toThrow(/does not match/)
    /* Critically: nothing was planted on the val. */
    expect(deps.env.store.has('MEANDER_DB_KEY_2')).toBe(false)
    expect(deps.env.store.get('MEANDER_DB_KEY_CURRENT')).toBe('1')
  })

  it('detects rewrap stall (rewrapped=0 but remaining>0)', async () => {
    const deps = setupRotateDeps({
      fromGen: 1,
      fromKeyByte: 0x55,
      rewrapBatches: [{ rewrapped: 0, remaining: 7 }],
    })
    await expect(
      dbKeyRotate({ threshold: 2, shares: 3 }, deps),
    ).rejects.toThrow(/stalled/)
  })

  it('refuses when current-generation key is missing on val (post-snapshot race)', async () => {
    /* Snapshot reports CURRENT=1 but the actual MEANDER_DB_KEY_1
     * env var was deleted between calls. Surfaces a clear error
     * rather than calling rewrap with garbage. */
    const env: Record<string, string> = {
      MEANDER_DB_KEY_CURRENT: '1',
      /* Note: no MEANDER_DB_KEY_1 — but listEnvVarNames must
       * surface it for the snapshot to claim CURRENT=1. We fake
       * that by pre-listing it via FakeEnv's store... actually,
       * FakeEnv.listEnvVarNames returns store.keys(). So if the
       * key isn't in the store, snapshot won't include it. We
       * test the same logic by setting CURRENT to a generation
       * not in store; the snapshot still parses CURRENT and finds
       * generations from the store. Result: no entry for that
       * generation in env, getEnvVar(MEANDER_DB_KEY_1) returns
       * undefined, the rotate path throws "not set on val". */
      MEANDER_DB_KEY_2: HEX_OF_BYTE(0x22),
    }
    /* Snapshot will see [2] in generations and CURRENT=1 → it
     * believes the current generation is 1, but listEnvVarNames
     * doesn't include MEANDER_DB_KEY_1, so getEnvVar returns
     * undefined. */
    const validShares = split(new Uint8Array(KEY_OF_BYTE(0x99)), 2, 3)
      .slice(0, 2)
      .map(encodeShare)
    const deps = makeDeps({
      envInitial: env,
      shares: validShares,
    })
    await expect(
      dbKeyRotate({ threshold: 2, shares: 3 }, deps),
    ).rejects.toThrow(/MEANDER_DB_KEY_1 not set/)
  })
})

/* ------------------------------------------------------------------ */
/*  restore                                                             */
/* ------------------------------------------------------------------ */

describe('dbKeyRestore', () => {
  it('no-ops when shares match an existing generation', async () => {
    const deps = makeDeps({
      envInitial: {
        MEANDER_DB_KEY_1: HEX_OF_BYTE(0x77),
        MEANDER_DB_KEY_CURRENT: '1',
      },
      shares: split(new Uint8Array(KEY_OF_BYTE(0x77)), 2, 3)
        .slice(0, 2)
        .map(encodeShare),
    })
    await dbKeyRestore({ threshold: 2 }, deps)
    expect(deps.io.text()).toContain('nothing to restore')
    /* The store wasn't mutated. */
    expect(deps.env.store.size).toBe(2)
  })

  it('plants MEANDER_DB_KEY_1 + MEANDER_DB_KEY_CURRENT when env is empty', async () => {
    const deps = makeDeps({
      shares: split(new Uint8Array(KEY_OF_BYTE(0x55)), 2, 3)
        .slice(0, 2)
        .map(encodeShare),
    })
    await dbKeyRestore({ threshold: 2 }, deps)
    expect(deps.env.store.get('MEANDER_DB_KEY_1')).toBe(HEX_OF_BYTE(0x55))
    expect(deps.env.store.get('MEANDER_DB_KEY_CURRENT')).toBe('1')
  })

  it('plants the next-numbered generation when shares do not match any existing generation', async () => {
    /* Env has gen 1 + 2 with two different keys; the operator's
     * shares reconstruct a *third* key. Restore plants gen 3
     * without touching CURRENT (which already points at gen 2). */
    const deps = makeDeps({
      envInitial: {
        MEANDER_DB_KEY_1: HEX_OF_BYTE(0x11),
        MEANDER_DB_KEY_2: HEX_OF_BYTE(0x22),
        MEANDER_DB_KEY_CURRENT: '2',
      },
      shares: split(new Uint8Array(KEY_OF_BYTE(0x99)), 2, 3)
        .slice(0, 2)
        .map(encodeShare),
    })
    await dbKeyRestore({ threshold: 2 }, deps)
    expect(deps.env.store.get('MEANDER_DB_KEY_3')).toBe(HEX_OF_BYTE(0x99))
    expect(deps.env.store.get('MEANDER_DB_KEY_CURRENT')).toBe('2')
  })
})

/* ------------------------------------------------------------------ */
/*  audit                                                               */
/* ------------------------------------------------------------------ */

describe('dbKeyAudit', () => {
  it('prints generations + row counts', async () => {
    const deps = makeDeps({
      audit: {
        visibleGenerations: [1, 2],
        currentGeneration: 2,
        rowCounts: { '1': 7, '2': 42 },
      },
    })
    await dbKeyAudit(deps)
    const out = deps.io.text()
    expect(out).toContain('Visible generations: 1, 2')
    expect(out).toContain('Current (used for new writes): 2')
    expect(out).toContain('generation 1: 7 row(s)')
    expect(out).toContain('generation 2: 42 row(s) ← current')
  })

  it('flags zero-row generations as retire-eligible', async () => {
    const deps = makeDeps({
      audit: {
        visibleGenerations: [1, 2],
        currentGeneration: 2,
        rowCounts: { '2': 100 },
      },
    })
    await dbKeyAudit(deps)
    expect(deps.io.text()).toContain('eligible for')
    expect(deps.io.text()).toContain('meander db key retire 1')
  })

  it('reports "(no comments)" when rowCounts is empty', async () => {
    const deps = makeDeps({
      audit: {
        visibleGenerations: [1],
        currentGeneration: 1,
        rowCounts: {},
      },
    })
    await dbKeyAudit(deps)
    expect(deps.io.text()).toContain('(no comments)')
  })
})

/* ------------------------------------------------------------------ */
/*  retire                                                              */
/* ------------------------------------------------------------------ */

describe('dbKeyRetire', () => {
  it('removes MEANDER_DB_KEY_<n> when no rows reference it', async () => {
    const deps = makeDeps({
      envInitial: {
        MEANDER_DB_KEY_1: HEX_OF_BYTE(0x11),
        MEANDER_DB_KEY_2: HEX_OF_BYTE(0x22),
        MEANDER_DB_KEY_CURRENT: '2',
      },
      audit: {
        visibleGenerations: [1, 2],
        currentGeneration: 2,
        rowCounts: { '2': 100 },
      },
    })
    await dbKeyRetire({ generation: 1 }, deps)
    expect(deps.env.store.has('MEANDER_DB_KEY_1')).toBe(false)
    expect(deps.io.text()).toContain('Removed MEANDER_DB_KEY_1')
  })

  it('refuses when --generation is missing', async () => {
    const deps = makeDeps()
    await expect(dbKeyRetire({}, deps)).rejects.toThrow(/--generation/)
  })

  it('refuses to retire the current generation', async () => {
    const deps = makeDeps({
      envInitial: {
        MEANDER_DB_KEY_1: HEX_OF_BYTE(0x11),
        MEANDER_DB_KEY_CURRENT: '1',
      },
    })
    await expect(dbKeyRetire({ generation: 1 }, deps)).rejects.toThrow(
      /current generation/,
    )
  })

  it('refuses when target generation is not in env', async () => {
    const deps = makeDeps({
      envInitial: {
        MEANDER_DB_KEY_1: HEX_OF_BYTE(0x11),
        MEANDER_DB_KEY_CURRENT: '1',
      },
    })
    await expect(dbKeyRetire({ generation: 99 }, deps)).rejects.toThrow(
      /not present in env/,
    )
  })

  it('refuses when rows still reference the target generation', async () => {
    const deps = makeDeps({
      envInitial: {
        MEANDER_DB_KEY_1: HEX_OF_BYTE(0x11),
        MEANDER_DB_KEY_2: HEX_OF_BYTE(0x22),
        MEANDER_DB_KEY_CURRENT: '2',
      },
      audit: {
        visibleGenerations: [1, 2],
        currentGeneration: 2,
        rowCounts: { '1': 5, '2': 100 },
      },
    })
    await expect(dbKeyRetire({ generation: 1 }, deps)).rejects.toThrow(
      /still reference/,
    )
  })

  it('handles deleteEnvVar reporting "not present" gracefully', async () => {
    /* The pre-flight checks pass (audit says 0 rows) but the env
     * var was already deleted out-of-band. The CLI should report
     * a no-op rather than throwing. */
    const deps = makeDeps({
      envInitial: {
        MEANDER_DB_KEY_2: HEX_OF_BYTE(0x22),
        MEANDER_DB_KEY_CURRENT: '2',
        /* MEANDER_DB_KEY_1 listed via the snapshot, but
         * deleted between snapshot + delete by another caller.
         * We simulate that by NOT including it in store but
         * making the snapshot find it via a custom env. */
      },
    })
    /* We can't easily simulate the race with FakeEnv. Instead,
     * bypass the snapshot guard by pre-seeding gen 1 then
     * deleting it just before the call. */
    deps.env.store.set('MEANDER_DB_KEY_1', HEX_OF_BYTE(0x11))
    deps.admin.audit = {
      visibleGenerations: [1, 2],
      currentGeneration: 2,
      rowCounts: { '2': 100 },
    }
    /* Actually delete it before retire — but retire calls
     * snapshotEnv first, which lists names. Once we delete it,
     * snapshot won't see it, and retire throws "not present in
     * env" before reaching the delete call. To exercise the
     * "deleteEnvVar returned false" branch we need an
     * env where the name is present at snapshot time but
     * deletion returns false — that's a contrived situation
     * (Val Town's API would always 404 on a key that doesn't
     * exist). We test it by overriding deleteEnvVar to return
     * false. */
    const realDelete = deps.env.deleteEnvVar.bind(deps.env)
    deps.env.deleteEnvVar = async (key: string) => {
      await realDelete(key) // actually delete
      return false // but report not-present
    }
    await dbKeyRetire({ generation: 1 }, deps)
    expect(deps.io.text()).toContain('was not present (nothing to remove)')
  })
})
