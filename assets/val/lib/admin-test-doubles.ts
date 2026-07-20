/**
 * Test doubles for assets/val/lib/admin.test.ts.
 *
 * Extracted from the test file so it stays under the fleet's
 * file-size cap. These are the hand-rolled Hono-compatible mock, the
 * wrapping-key fixture, and the in-memory sqlite stand-in the admin
 * route tests drive through `app.fetch` — the exact surface Val
 * Town's runtime invokes. Kept out of the real `npm:hono@4` /
 * `https://esm.town/v/std/sqlite` dependencies so the suite runs
 * under `node --test`.
 *
 * This module is intentionally NOT named `*.test.ts`: it holds no
 * tests, only factories, so the `node --test` glob skips it.
 */

import { importKey, registerAdminRoutes } from './admin.ts'
import type { AdminDeps, AdminKeyContext, SqliteClient } from './admin.ts'
import { randomDataKeyBytes } from './crypto.ts'

/**
 * Mini Hono — just enough surface for registerAdminRoutes and
 * fetch-based dispatch. The real Hono brings a router, body
 * parsing helpers, and chaining; we need none of that. The shape
 * matches `Hono` structurally for TypeScript's purposes via
 * `as unknown as Hono`.
 */
export type Route = {
  method: 'GET' | 'POST'
  path: string
  handler: (c: TestContext) => Promise<Response> | Response
}

export type TestContext = {
  req: {
    header: (name: string) => string | null
    json: () => Promise<unknown>
    param: (name: string) => string | undefined
    query: (name: string) => string | undefined
  }
  json: (body: unknown, status?: number) => Response
  text: (body: string, status?: number) => Response
  html: (body: string) => Response
}

export function makeApp() {
  const routes: Route[] = []
  const app = {
    get(path: string, handler: Route['handler']) {
      routes.push({ method: 'GET', path, handler })
      return app
    },
    post(path: string, handler: Route['handler']) {
      routes.push({ method: 'POST', path, handler })
      return app
    },
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const route = routes.find(
        r => r.method === req.method && r.path === url.pathname,
      )
      if (!route) {
        return new Response('not found', { status: 404 })
      }
      const ctx: TestContext = {
        req: {
          header: (name: string) => req.headers.get(name),
          json: () => req.clone().json(),
          param: () => undefined,
          query: (name: string) => url.searchParams.get(name) ?? undefined,
        },
        json: (body, status) =>
          new Response(JSON.stringify(body), {
            status: status ?? 200,
            headers: { 'content-type': 'application/json' },
          }),
        text: (body, status) =>
          new Response(body, {
            status: status ?? 200,
            headers: { 'content-type': 'text/plain' },
          }),
        html: body =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      }
      return route.handler(ctx)
    },
  }
  return app
}

export async function makeKeyContext(
  generations: number[],
  current: number,
): Promise<AdminKeyContext & { rawKeys: Map<number, Uint8Array> }> {
  const rawKeys = new Map<number, Uint8Array>()
  const importedKeys = new Map<number, CryptoKey>()
  for (let i = 0, { length } = generations; i < length; i += 1) {
    const gen = generations[i]!
    const raw = randomDataKeyBytes()
    rawKeys.set(gen, raw)
    importedKeys.set(gen, await importKey(raw))
  }
  return {
    currentGeneration: current,
    visibleGenerations: () => generations.slice(),
    async getKey(gen) {
      const k = importedKeys.get(gen)
      if (!k) {
        throw new Error(`generation ${gen} not in test fixture`)
      }
      return k
    },
    rawKeys,
  }
}

/**
 * In-memory sqlite stand-in. Only implements the SQL shapes the
 * admin handlers use:
 *
 * - SELECT key_generation, COUNT(*) AS n FROM comments GROUP BY ...
 * - SELECT id, dek_wrapped FROM comments WHERE key_generation = :gen LIMIT :n
 * - UPDATE comments SET dek_wrapped = :wrapped, key_generation = :gen WHERE id =
 *   :id
 * - SELECT COUNT(*) AS n FROM comments WHERE key_generation = :gen
 */
export type Row = { id: string; dek_wrapped: string; key_generation: number }

export function makeSqlite(initial: Row[]) {
  const rows: Row[] = initial.map(r => ({ ...r }))
  let ensureCalls = 0
  const sqlite: SqliteClient & {
    rows: () => Row[]
    ensureCalls: () => number
  } = {
    rows: () => rows.map(r => ({ ...r })),
    ensureCalls: () => ensureCalls,
    async execute(arg) {
      const text = typeof arg === 'string' ? arg : arg.sql
      const args = typeof arg === 'string' ? {} : (arg.args ?? {})
      const sql = text.replace(/\s+/g, ' ').trim()
      if (
        sql.startsWith('SELECT key_generation, COUNT(*) AS n FROM comments')
      ) {
        const counts = new Map<number, number>()
        for (let i = 0, { length } = rows; i < length; i += 1) {
          const r = rows[i]!
          counts.set(r.key_generation, (counts.get(r.key_generation) ?? 0) + 1)
        }
        const out = [...counts.entries()]
          .toSorted((a, b) => a[0] - b[0])
          .map(([key_generation, n]) => ({ key_generation, n }))
        return { rows: out }
      }
      if (
        sql.startsWith(
          'SELECT id, dek_wrapped FROM comments WHERE key_generation = :gen LIMIT :n',
        )
      ) {
        const gen = Number(args['gen'])
        const limit = Number(args['n'])
        return {
          rows: rows
            .filter(r => r.key_generation === gen)
            .slice(0, limit)
            .map(r => ({ id: r.id, dek_wrapped: r.dek_wrapped })),
        }
      }
      if (
        sql.startsWith(
          'UPDATE comments SET dek_wrapped = :wrapped, key_generation = :gen WHERE id = :id',
        )
      ) {
        const id = String(args['id'])
        const wrapped = String(args['wrapped'])
        const gen = Number(args['gen'])
        const idx = rows.findIndex(r => r.id === id)
        if (idx >= 0) {
          rows[idx]!.dek_wrapped = wrapped
          rows[idx]!.key_generation = gen
        }
        return { rows: [] }
      }
      if (
        sql.startsWith(
          'SELECT COUNT(*) AS n FROM comments WHERE key_generation = :gen',
        )
      ) {
        const gen = Number(args['gen'])
        const n = rows.filter(r => r.key_generation === gen).length
        return { rows: [{ n }] }
      }
      throw new Error(`unhandled SQL: ${sql}`)
    },
  }
  return Object.assign(sqlite, {
    incEnsure: () => {
      ensureCalls++
    },
  })
}

export function setupApp(deps: AdminDeps) {
  const app = makeApp()
  registerAdminRoutes(
    app as unknown as Parameters<typeof registerAdminRoutes>[0],
    deps,
  )
  return app
}
