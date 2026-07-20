/**
 * Admin route handlers for the val.
 *
 * Lives in its own module so tests can drive the handlers without
 * pulling in `https://esm.town/v/std/blob` etc. at import time. The
 * handlers receive their dependencies (sqlite client, wrapping-key
 * lookup, admin token) via a `Deps` struct passed when registering
 * routes — `assets/val/index.ts` builds that struct at module load
 * from Deno.env + the val-town imports.
 *
 * Endpoints:
 * GET  /admin/key-audit    Per-generation row counts + the
 * current pointer.
 * POST /admin/rewrap       Re-wrap rows from one generation to
 * another. Body: { fromGeneration,
 * toGeneration, batchSize? }. Idempotent
 * \+ cursor-driven.
 *
 * Both endpoints require `Authorization: Bearer <admin token>`.
 * The token is constant-time-compared so timing won't leak its
 * length.
 */

import type { Hono } from 'npm:hono@4'
import type { Context } from 'npm:hono@4'

import { importKey, unwrapKey, wrapKey } from './crypto.ts'

export function adminAuth(
  c: Context,
  adminToken: string,
): Response | undefined {
  if (!adminToken) {
    return c.json(
      { error: 'admin disabled — MEANDER_ADMIN_TOKEN not set on val' },
      503,
    )
  }
  const auth = c.req.header('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) {
    return c.json({ error: 'admin auth required' }, 401)
  }
  if (!constantTimeEqual(m[1]!, adminToken)) {
    return c.json({ error: 'admin auth failed' }, 401)
  }
  return undefined
}

/**
 * SQLite client surface the handlers depend on (a slice of
 * `https://esm.town/v/std/sqlite/main.ts`). Tests pass a stub.
 */
export type SqliteClient = {
  execute: (
    arg: string | { sql: string; args?: Record<string, unknown> | undefined },
  ) => Promise<{ rows: readonly unknown[] }>
}

/**
 * Wrapping-key context — same shape as ./keys.ts's
 * `WrappingKeyContext`, restated here so tests don't need to
 * build a full Deno-env-backed context to exercise the routes.
 */
export type AdminKeyContext = {
  currentGeneration: number
  getKey: (generation: number) => Promise<CryptoKey>
  visibleGenerations: () => number[]
}

export type AdminDeps = {
  sqlite: SqliteClient
  ensureDb: () => Promise<void>
  /**
   * May be undefined when the val booted without a configured
   * wrapping key — admin routes surface a 500 in that case.
   */
  keyContext: AdminKeyContext | undefined
  /**
   * Reason the keyContext is missing. Surfaced verbatim in the
   * error body to help operators debug.
   */
  keyContextError: string | undefined
  /**
   * Admin bearer token. Empty string disables admin routes
   * (the val returns 503).
   */
  adminToken: string
}

/**
 * Constant-time string comparison. JS `===` short-circuits on the
 * first mismatched character; this loops over `max(a, b)` so the
 * comparison's runtime is independent of which input the caller
 * supplied. Mismatched lengths still reject (via the seeded
 * length-XOR), but in equal time.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return diff === 0
}

export function noKeyContextResponse(c: Context, deps: AdminDeps): Response {
  const reason =
    deps.keyContextError ??
    'server missing MEANDER_DB_KEY_<n> + MEANDER_DB_KEY_CURRENT — run `meander db key init`'
  return c.json({ error: reason }, 500)
}

/**
 * Register both admin routes on the Hono app. Returns the same app
 * for chainability — matches Hono's idiom.
 */
export function registerAdminRoutes(app: Hono, deps: AdminDeps): Hono {
  app.get('/admin/key-audit', async c => {
    const denied = adminAuth(c, deps.adminToken)
    if (denied) {
      return denied
    }
    await deps.ensureDb()
    if (!deps.keyContext) {
      return noKeyContextResponse(c, deps)
    }
    const result = await deps.sqlite.execute(`
      SELECT key_generation, COUNT(*) AS n FROM comments GROUP BY key_generation ORDER BY key_generation ASC
    `)
    const counts: Record<string, number> = Object.create(null)
    for (const row of result.rows as Array<{
      key_generation: number
      n: number
    }>) {
      counts[String(row.key_generation)] = Number(row.n)
    }
    return c.json({
      visibleGenerations: deps.keyContext.visibleGenerations(),
      currentGeneration: deps.keyContext.currentGeneration,
      rowCounts: counts,
    })
  })

  app.post('/admin/rewrap', async c => {
    const denied = adminAuth(c, deps.adminToken)
    if (denied) {
      return denied
    }
    await deps.ensureDb()
    if (!deps.keyContext) {
      return noKeyContextResponse(c, deps)
    }
    const body = await c.req.json().catch(() => ({}))
    const fromGen = Number(body.fromGeneration)
    const toGen = Number(body.toGeneration)
    const batchSize = Number(body.batchSize ?? 100)
    if (
      !Number.isInteger(fromGen) ||
      !Number.isInteger(toGen) ||
      fromGen <= 0 ||
      toGen <= 0 ||
      fromGen === toGen
    ) {
      return c.json(
        {
          error:
            'fromGeneration and toGeneration must be distinct positive integers',
        },
        400,
      )
    }
    if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 1000) {
      return c.json({ error: 'batchSize must be in [1, 1000]' }, 400)
    }

    const fromKey = await deps.keyContext.getKey(fromGen)
    const toKey = await deps.keyContext.getKey(toGen)

    const result = await deps.sqlite.execute({
      sql: 'SELECT id, dek_wrapped FROM comments WHERE key_generation = :gen LIMIT :n',
      args: { gen: fromGen, n: batchSize },
    })
    const rows = result.rows as Array<{ id: string; dek_wrapped: string }>

    let rewrapped = 0
    for (const row of rows) {
      const dekBytes = await unwrapKey(row.dek_wrapped, fromKey)
      const newWrapped = await wrapKey(dekBytes, toKey)
      await deps.sqlite.execute({
        sql: 'UPDATE comments SET dek_wrapped = :wrapped, key_generation = :gen WHERE id = :id',
        args: { wrapped: newWrapped, gen: toGen, id: row.id },
      })
      rewrapped++
    }

    const remainingResult = await deps.sqlite.execute({
      sql: 'SELECT COUNT(*) AS n FROM comments WHERE key_generation = :gen',
      args: { gen: fromGen },
    })
    const remaining = Number(
      (remainingResult.rows as Array<{ n: number }>)[0]?.n ?? 0,
    )

    return c.json({ rewrapped, remaining })
  })

  return app
}

/* Re-export the crypto helpers admin tests are likely to need
 * alongside this module — keeps the test imports tidy. */
export { importKey, unwrapKey, wrapKey }
