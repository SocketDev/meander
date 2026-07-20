/**
 * @file Tests for assets/val/lib/admin.ts.
 *   The admin handlers depend on a Hono app + a sqlite client + a
 *   wrapping-key context. The hand-rolled Hono-compatible mock and
 *   stubbed sqlite client live in `./admin-test-doubles.ts` (extracted
 *   so this file stays under the fleet's file-size cap), so the test
 *   runs under `node --test` without pulling in the real `npm:hono@4` /
 *   `https://esm.town/v/std/sqlite` dependencies.
 *   We test the routes through `app.fetch`, which is the exact
 *   surface Val Town's runtime invokes. So the handler runs in
 *   the same shape it would in production.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { constantTimeEqual, unwrapKey, wrapKey } from './admin.ts'
import { randomDataKeyBytes } from './crypto.ts'
import { makeKeyContext, makeSqlite, setupApp } from './admin-test-doubles.ts'
import type { Row } from './admin-test-doubles.ts'

/* ------------------------------------------------------------------ */
/*  constantTimeEqual                                                   */
/* ------------------------------------------------------------------ */

test('constantTimeEqual: identical strings match', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true)
  assert.equal(constantTimeEqual('', ''), true)
})

test('constantTimeEqual: different strings reject', () => {
  assert.equal(constantTimeEqual('abc', 'abd'), false)
  assert.equal(constantTimeEqual('abc', 'abcd'), false)
  assert.equal(constantTimeEqual('abcd', 'abc'), false)
})

test('constantTimeEqual: empty vs non-empty reject', () => {
  assert.equal(constantTimeEqual('', 'a'), false)
  assert.equal(constantTimeEqual('a', ''), false)
})

/* ------------------------------------------------------------------ */
/*  /admin/key-audit auth                                              */
/* ------------------------------------------------------------------ */

test('admin: returns 503 when MEANDER_ADMIN_TOKEN is unset', async () => {
  const sqlite = makeSqlite([])
  const ctx = await makeKeyContext([1], 1)
  const app = setupApp({
    sqlite,
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: '',
  })
  const res = await app.fetch(
    new Request('http://localhost/admin/key-audit', {
      headers: { authorization: 'Bearer whatever' },
    }),
  )
  assert.equal(res.status, 503)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /MEANDER_ADMIN_TOKEN/)
})

test('admin: returns 401 when Authorization header is missing', async () => {
  const ctx = await makeKeyContext([1], 1)
  const app = setupApp({
    sqlite: makeSqlite([]),
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })
  const res = await app.fetch(new Request('http://localhost/admin/key-audit'))
  assert.equal(res.status, 401)
})

test('admin: returns 401 on wrong bearer token', async () => {
  const ctx = await makeKeyContext([1], 1)
  const app = setupApp({
    sqlite: makeSqlite([]),
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })
  const res = await app.fetch(
    new Request('http://localhost/admin/key-audit', {
      headers: { authorization: 'Bearer wrong-token' },
    }),
  )
  assert.equal(res.status, 401)
})

test('admin: returns 500 with the keyContextError when key context is missing', async () => {
  const app = setupApp({
    sqlite: makeSqlite([]),
    ensureDb: async () => {},
    keyContext: undefined,
    keyContextError: 'MEANDER_DB_KEY_CURRENT must be set to one of: 1',
    adminToken: 'admin-token-xyz',
  })
  const res = await app.fetch(
    new Request('http://localhost/admin/key-audit', {
      headers: { authorization: 'Bearer admin-token-xyz' },
    }),
  )
  assert.equal(res.status, 500)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /MEANDER_DB_KEY_CURRENT/)
})

/* ------------------------------------------------------------------ */
/*  /admin/key-audit happy path                                        */
/* ------------------------------------------------------------------ */

test('admin: key-audit reports per-generation row counts', async () => {
  const ctx = await makeKeyContext([1, 2], 2)
  const sqlite = makeSqlite([
    { id: 'a', dek_wrapped: 'old1', key_generation: 1 },
    { id: 'b', dek_wrapped: 'old2', key_generation: 1 },
    { id: 'c', dek_wrapped: 'new1', key_generation: 2 },
  ])
  const app = setupApp({
    sqlite,
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })
  const res = await app.fetch(
    new Request('http://localhost/admin/key-audit', {
      headers: { authorization: 'Bearer admin-token-xyz' },
    }),
  )
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    visibleGenerations: number[]
    currentGeneration: number
    rowCounts: Record<string, number>
  }
  assert.deepEqual(body.visibleGenerations, [1, 2])
  assert.equal(body.currentGeneration, 2)
  assert.deepEqual(body.rowCounts, { '1': 2, '2': 1 })
})

test('admin: key-audit returns empty rowCounts when no rows', async () => {
  const ctx = await makeKeyContext([1], 1)
  const app = setupApp({
    sqlite: makeSqlite([]),
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })
  const res = await app.fetch(
    new Request('http://localhost/admin/key-audit', {
      headers: { authorization: 'Bearer admin-token-xyz' },
    }),
  )
  const body = (await res.json()) as { rowCounts: Record<string, number> }
  assert.deepEqual(body.rowCounts, {})
})

/* ------------------------------------------------------------------ */
/*  /admin/rewrap input validation                                     */
/* ------------------------------------------------------------------ */

test('admin: rewrap rejects same fromGeneration / toGeneration', async () => {
  const ctx = await makeKeyContext([1, 2], 1)
  const app = setupApp({
    sqlite: makeSqlite([]),
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })
  const res = await app.fetch(
    new Request('http://localhost/admin/rewrap', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token-xyz',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fromGeneration: 1, toGeneration: 1 }),
    }),
  )
  assert.equal(res.status, 400)
  const body = (await res.json()) as { error: string }
  assert.match(body.error, /distinct/)
})

test('admin: rewrap rejects negative generations', async () => {
  const ctx = await makeKeyContext([1, 2], 1)
  const app = setupApp({
    sqlite: makeSqlite([]),
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })
  const res = await app.fetch(
    new Request('http://localhost/admin/rewrap', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token-xyz',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fromGeneration: -1, toGeneration: 2 }),
    }),
  )
  assert.equal(res.status, 400)
})

test('admin: rewrap rejects out-of-range batchSize', async () => {
  const ctx = await makeKeyContext([1, 2], 1)
  const app = setupApp({
    sqlite: makeSqlite([]),
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })
  const tooBig = await app.fetch(
    new Request('http://localhost/admin/rewrap', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token-xyz',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fromGeneration: 1,
        toGeneration: 2,
        batchSize: 100_000,
      }),
    }),
  )
  assert.equal(tooBig.status, 400)
  const tooSmall = await app.fetch(
    new Request('http://localhost/admin/rewrap', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token-xyz',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fromGeneration: 1,
        toGeneration: 2,
        batchSize: 0,
      }),
    }),
  )
  assert.equal(tooSmall.status, 400)
})

/* ------------------------------------------------------------------ */
/*  /admin/rewrap happy path — the headline case                       */
/* ------------------------------------------------------------------ */

test('admin: rewrap re-wraps DEKs from gen 1 → gen 2 without touching ciphertext', async () => {
  /* Build realistic seed data: 5 rows under generation 1, each
   * with a real wrapped DEK we can validate after rewrap. */
  const ctx = await makeKeyContext([1, 2], 1)
  const wrapping1 = await ctx.getKey(1)
  const wrapping2 = await ctx.getKey(2)
  const initial: Row[] = []
  const dekBytesById = new Map<string, Uint8Array>()
  for (let i = 0; i < 5; i++) {
    const dek = randomDataKeyBytes()
    dekBytesById.set(`row-${i}`, dek)
    initial.push({
      id: `row-${i}`,
      dek_wrapped: await wrapKey(dek, wrapping1),
      key_generation: 1,
    })
  }
  const sqlite = makeSqlite(initial)
  const app = setupApp({
    sqlite,
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })

  /* First call: batchSize 3 should rewrap 3 rows, leave 2 remaining. */
  const first = await app.fetch(
    new Request('http://localhost/admin/rewrap', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token-xyz',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fromGeneration: 1,
        toGeneration: 2,
        batchSize: 3,
      }),
    }),
  )
  assert.equal(first.status, 200)
  const firstBody = (await first.json()) as {
    rewrapped: number
    remaining: number
  }
  assert.equal(firstBody.rewrapped, 3)
  assert.equal(firstBody.remaining, 2)

  /* Second call: drains the rest. */
  const second = await app.fetch(
    new Request('http://localhost/admin/rewrap', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token-xyz',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        fromGeneration: 1,
        toGeneration: 2,
        batchSize: 100,
      }),
    }),
  )
  const secondBody = (await second.json()) as {
    rewrapped: number
    remaining: number
  }
  assert.equal(secondBody.rewrapped, 2)
  assert.equal(secondBody.remaining, 0)

  /* All rows now tagged generation 2; their wrapped DEKs unwrap
   * correctly under wrapping2 and recover the original DEK bytes. */
  for (const row of sqlite.rows()) {
    assert.equal(row.key_generation, 2)
    const recovered = await unwrapKey(row.dek_wrapped, wrapping2)
    const original = dekBytesById.get(row.id)!
    assert.deepEqual(Array.from(recovered), Array.from(original))
  }
})

test('admin: rewrap is idempotent — calling with no rows in the from generation reports 0/0', async () => {
  const ctx = await makeKeyContext([1, 2], 2)
  const app = setupApp({
    sqlite: makeSqlite([]),
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })
  const res = await app.fetch(
    new Request('http://localhost/admin/rewrap', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-token-xyz',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fromGeneration: 1, toGeneration: 2 }),
    }),
  )
  const body = (await res.json()) as { rewrapped: number; remaining: number }
  assert.equal(body.rewrapped, 0)
  assert.equal(body.remaining, 0)
})

test('admin: rewrap propagates getKey failure when generation key is missing', async () => {
  /* Seeded with rows at gen 1, but the key context only has gen 2 +
   * gen 3. Calling rewrap from 1 → 2 should fail (gen 1 key absent). */
  const ctx = await makeKeyContext([2, 3], 2)
  const sqlite = makeSqlite([
    { id: 'orphan', dek_wrapped: 'doesnt-matter', key_generation: 1 },
  ])
  const app = setupApp({
    sqlite,
    ensureDb: async () => {},
    keyContext: ctx,
    keyContextError: undefined,
    adminToken: 'admin-token-xyz',
  })
  await assert.rejects(
    app.fetch(
      new Request('http://localhost/admin/rewrap', {
        method: 'POST',
        headers: {
          authorization: 'Bearer admin-token-xyz',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ fromGeneration: 1, toGeneration: 2 }),
      }),
    ),
    /generation 1 not in test fixture/,
  )
})
