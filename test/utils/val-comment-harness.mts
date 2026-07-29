/**
 * @file Harness for the val's comment-route suites
 *   (test/val-comment-export.test.mts, test/val-comment-mutations.test.mts).
 *   `registerCommentRoutes` takes the Hono app and a `CommentDeps` struct, so
 *   this hands it a recorder app (collects `method path` → handler) and a fake
 *   Hono context. Nothing here stubs the gate: `currentUser` verifies a real
 *   HS256 session token through `lib/session.ts`, `authRequired` is the real
 *   `authGate`, and
 *   rows carry real AES-256-GCM ciphertext, so a token with a valid shape but a
 *   bad signature is rejected by the code under test rather than by a mock.
 *   The fake sqlite interprets the WHERE clause it is handed, so a query that
 *   drops its `slug = :slug` scoping starts matching rows from other
 *   walkthroughs and the cross-walkthrough tests go red.
 *   The reader gate is unstubbed the same way. `isSlugPrivate` runs the real
 *   `resolveSlugPrivacy` over the fake sqlite and a fake blob store, so a read
 *   of a slug named in `privateSlugs` really does probe a real `ENVELOPE:`
 *   blob, record the verdict, and answer from the recorded row afterwards.
 *   Cookies are parsed from a real `Cookie` header and reader tokens are real
 *   HS256 JWTs.
 */

import type { EncryptedCommentRow } from '../../assets/val/lib/comment-store.ts'
import { registerCommentRoutes } from '../../assets/val/lib/comments.ts'
import { authGate } from '../../assets/val/lib/auth.ts'
import {
  encrypt,
  importKey,
  packEnvelope,
  randomDataKeyBytes,
  wrapKey,
} from '../../assets/val/lib/crypto.ts'
import {
  mintReaderToken,
  mintSessionToken,
  READER_COOKIE_NAME,
  readSessionToken,
} from '../../assets/val/lib/session.ts'
import {
  probeSlugPrivacy,
  resolveSlugPrivacy,
} from '../../assets/val/lib/visibility.ts'

export const JWT_SECRET = 'test-jwt-secret'
export const ADMIN_TOKEN = 'test-admin-token'

export const EXPORT_ROUTE = 'GET /:slug/api/comments/export'
export const PATCH_ROUTE = 'PATCH /:slug/api/comments/:id'
export const DELETE_ROUTE = 'DELETE /:slug/api/comments/:id'
export const READ_ROUTE = 'GET /:slug/api/comments'
export const UNRESOLVED_ROUTE = 'GET /:slug/api/comments/unresolved'
const WRAPPING_KEY_BYTES = new Uint8Array(32).fill(0x5a)
const BLOB_KEY_BYTES = new Uint8Array(32).fill(0x3c)

export type FakeResponse = {
  status: number
  body: unknown
  headers: Record<string, string>
}

export type RouteHandler = (c: FakeContext) => Promise<FakeResponse>

export type FakeContext = {
  req: {
    param: (name: string) => string | undefined
    query: (name: string) => string | undefined
    header: (name: string) => string | undefined
    json: () => Promise<unknown>
  }
  header: (name: string, value: string) => void
  json: (body: unknown, status?: number | undefined) => FakeResponse
}

export type RequestSpec = {
  params?: Record<string, string> | undefined
  query?: Record<string, string> | undefined
  token?: string | undefined
  /**
   * Raw `Cookie` request header. Build one with `readerCookieFor`.
   */
  cookie?: string | undefined
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- fleet optional-explicit-undefined convention: the explicit | undefined on an optional is intentional, not redundant.
  body?: unknown | undefined
}

/* ------------------------------------------------------------------ */
/*  Fakes                                                               */
/* ------------------------------------------------------------------ */

/**
 * Hono stand-in: records each registered handler under
 * `<METHOD> <path>` so a test can invoke one directly.
 */
export function makeRecorderApp() {
  const routes = new Map<string, RouteHandler>()
  const app = {
    routes,
    get: (path: string, handler: RouteHandler) => {
      routes.set(`GET ${path}`, handler)
      return app
    },
    post: (path: string, handler: RouteHandler) => {
      routes.set(`POST ${path}`, handler)
      return app
    },
    patch: (path: string, handler: RouteHandler) => {
      routes.set(`PATCH ${path}`, handler)
      return app
    },
    delete: (path: string, handler: RouteHandler) => {
      routes.set(`DELETE ${path}`, handler)
      return app
    },
  }
  return app
}

export function makeContext(request: RequestSpec): FakeContext {
  const spec = { __proto__: null, ...request } as RequestSpec
  const headers: Record<string, string> = {}
  return {
    req: {
      param: (name: string) => spec.params?.[name],
      query: (name: string) => spec.query?.[name],
      header: (name: string) => {
        const lower = name.toLowerCase()
        if (lower === 'authorization') {
          return spec.token ? `Bearer ${spec.token}` : undefined
        }
        if (lower === 'cookie') {
          return spec.cookie
        }
        return undefined
      },
      json: async () => spec.body,
    },
    header: (name: string, value: string) => {
      headers[name] = value
    },
    json: (body: unknown, status?: number | undefined) => ({
      status: status ?? 200,
      body,
      headers,
    }),
  }
}

/**
 * In-memory `comments` table that reads the SQL it is given rather
 * than assuming a shape, so a handler that forgets to scope by slug
 * really does see the other walkthrough's rows.
 */
export class FakeSqlite {
  rows: EncryptedCommentRow[] = []
  readonly statements: string[] = []
  /**
   * The `walkthrough_visibility` table: slug → 1 when private. A
   * separate map because the visibility statements name their own
   * table and never touch `comments`.
   */
  readonly visibility = new Map<string, number>()

  async execute(
    arg: string | { sql: string; args?: Record<string, unknown> | undefined },
  ): Promise<{ rows: readonly unknown[] }> {
    const sql = typeof arg === 'string' ? arg : arg.sql
    const args = typeof arg === 'string' ? {} : (arg.args ?? {})
    this.statements.push(sql)
    if (sql.includes('walkthrough_visibility')) {
      return this.executeVisibility(sql, args)
    }
    const matches = this.matching(sql, args)
    if (sql.startsWith('SELECT')) {
      return { rows: matches }
    }
    if (sql.startsWith('UPDATE')) {
      for (const row of matches) {
        row.resolved = Number(args['resolved'])
      }
      return { rows: [] }
    }
    if (sql.startsWith('DELETE')) {
      const doomed = new Set(matches.map(row => row.id))
      this.rows = this.rows.filter(row => !doomed.has(row.id))
      return { rows: [] }
    }
    return { rows: [] }
  }

  executeVisibility(
    sql: string,
    args: Record<string, unknown>,
  ): { rows: readonly unknown[] } {
    const slug = String(args['slug'])
    if (sql.startsWith('SELECT')) {
      const recorded = this.visibility.get(slug)
      return { rows: recorded === undefined ? [] : [{ is_private: recorded }] }
    }
    if (sql.startsWith('INSERT')) {
      this.visibility.set(slug, Number(args['isPrivate']))
    }
    return { rows: [] }
  }

  matching(sql: string, args: Record<string, unknown>): EncryptedCommentRow[] {
    return this.rows.filter(row => {
      if (sql.includes('slug = :slug') && row.slug !== args['slug']) {
        return false
      }
      if (sql.includes('(id = :id OR parent_id = :id)')) {
        if (row.id !== args['id'] && row.parent_id !== args['id']) {
          return false
        }
      } else if (sql.includes('id = :id') && row.id !== args['id']) {
        return false
      }
      if (sql.includes('part = :part') && row.part !== args['part']) {
        return false
      }
      if (sql.includes('resolved = 0') && row.resolved !== 0) {
        return false
      }
      if (sql.includes('parent_id IS NULL') && row.parent_id) {
        return false
      }
      return true
    })
  }
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                            */
/* ------------------------------------------------------------------ */

export async function makeKeyContext() {
  const wrapping = await importKey(WRAPPING_KEY_BYTES)
  return {
    currentGeneration: 1,
    getKey: async () => wrapping,
    getCurrentKey: async () => wrapping,
    visibleGenerations: () => [1],
  }
}

export type RowSpec = {
  id: string
  slug: string
  author: string
  body?: string | undefined
  parentId?: string | undefined
  part?: number | undefined
  resolved?: number | undefined
}

export async function makeRow(spec: RowSpec): Promise<EncryptedCommentRow> {
  const wrapping = await importKey(WRAPPING_KEY_BYTES)
  const dekBytes = randomDataKeyBytes()
  const dek = await importKey(dekBytes)
  return {
    id: spec.id,
    slug: spec.slug,
    part: spec.part ?? 1,
    file: 'src/index.ts',
    line_from: 10,
    line_to: 12,
    author: await encrypt(spec.author, dek),
    body: await encrypt(spec.body ?? 'a remark', dek),
    dek_wrapped: await wrapKey(dekBytes, wrapping),
    key_generation: 1,
    // oxlint-disable-next-line socket/prefer-undefined-over-null -- mirrors the SQL NULL a root comment stores in parent_id.
    parent_id: spec.parentId ?? null,
    resolved: spec.resolved ?? 0,
    created_at: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * Seal HTML the way `meander publish` does with `encryptBlobs: true`,
 * so a probe of the fake blob store meets a real `ENVELOPE:` prefix.
 */
export async function encryptedBlobText(html: string): Promise<string> {
  const wrapping = await importKey(BLOB_KEY_BYTES)
  const dekBytes = randomDataKeyBytes()
  const dek = await importKey(dekBytes)
  return packEnvelope(
    await encrypt(html, dek),
    await wrapKey(dekBytes, wrapping),
  )
}

/**
 * A `Cookie` request header carrying a reader token for `slug`.
 */
export async function readerCookieFor(
  email: string,
  slug: string,
  ttlSeconds = 3600,
): Promise<string> {
  const token = await mintReaderToken(email, slug, JWT_SECRET, ttlSeconds)
  return `${READER_COOKIE_NAME}=${token}`
}

export type HarnessOptions = {
  allowedDomains?: readonly string[] | undefined
  demoMode?: boolean | undefined
  adminToken?: string | undefined
  jwtSecret?: string | undefined
  /**
   * Slugs whose blob store answers with no index page at all, which
   * is how a slug the deployment never published looks.
   */
  missingSlugs?: readonly string[] | undefined
  /**
   * Slugs published with `encryptBlobs: true`. Their fake blobs are
   * really envelope-sealed, so the gate decides on a prefix rather
   * than on a flag the harness handed it. Every other slug serves
   * plaintext and stays public.
   */
  privateSlugs?: readonly string[] | undefined
  withKeyContext?: boolean | undefined
}

/**
 * Wire the real routes against fakes. `demoMode` and
 * `allowedDomains` flow into the real `authGate`, `currentUser`
 * verifies the JWT signature for real, and `isSlugPrivate` runs the
 * real `resolveSlugPrivacy` over the fake sqlite + blob store.
 */
export async function makeHarness(overrides: HarnessOptions = {}) {
  const opts = { __proto__: null, ...overrides } as HarnessOptions
  const missingSlugs = opts.missingSlugs ?? []
  const privateSlugs = opts.privateSlugs ?? []
  const app = makeRecorderApp()
  const sqlite = new FakeSqlite()
  const keyContext = await makeKeyContext()
  const blobReads: string[] = []
  const readBlobText = async (
    relativeKey: string,
  ): Promise<string | undefined> => {
    blobReads.push(relativeKey)
    const slug = relativeKey.slice(0, relativeKey.indexOf('/'))
    if (missingSlugs.includes(slug)) {
      return undefined
    }
    return privateSlugs.includes(slug)
      ? encryptedBlobText(`<html>${slug}</html>`)
      : `<html>${slug}</html>`
  }
  registerCommentRoutes(
    app as never,
    {
      sqlite,
      ensureDb: async () => {},
      allowedDomains: opts.allowedDomains ?? ['socket.dev'],
      currentUser: async (c: FakeContext) => {
        const auth = c.req.header('authorization') || ''
        const m = auth.match(/^Bearer\s+(.+)$/i)
        if (!m) {
          return undefined
        }
        return readSessionToken(m[1]!, JWT_SECRET)
      },
      authRequired: (email, options) =>
        authGate(email, {
          allowedDomains: opts.allowedDomains ?? ['socket.dev'],
          demoMode: opts.demoMode ?? false,
          operation: options?.operation,
        }),
      isSlugPrivate: (slug: string) =>
        resolveSlugPrivacy(sqlite, slug, s =>
          probeSlugPrivacy(readBlobText, s),
        ),
      jwtSecret: opts.jwtSecret ?? JWT_SECRET,
      keyContext: opts.withKeyContext === false ? undefined : keyContext,
      keyContextError: undefined,
      adminToken: opts.adminToken ?? ADMIN_TOKEN,
    } as never,
  )
  return {
    app,
    sqlite,
    blobReads: () => blobReads.slice(),
    call: (route: string, request: RequestSpec) => {
      const handler = app.routes.get(route)
      if (!handler) {
        throw new Error(`no handler registered for ${route}`)
      }
      return handler(makeContext(request))
    },
  }
}

export async function sessionFor(email: string): Promise<string> {
  return mintSessionToken(email, JWT_SECRET, 3600)
}
