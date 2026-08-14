/**
 * Test doubles for test/val/pages.test.ts.
 *
 * Extracted from the test file so it stays under the fleet's
 * file-size cap. These are a hand-rolled Hono-compatible mock with
 * `:param` support, an in-memory blob store, and a fixture builder
 * that produces real `ENVELOPE:`-prefixed ciphertext. `app.dispatch`
 * runs the val's own handler in-process on a `http://localhost`
 * URL — nothing here opens a socket.
 *
 * Nothing here stubs the gate. `registerPageRoutes` gets the real
 * `resolveReaderAccess`, cookies are parsed from a real `Cookie`
 * header, reader tokens are real HS256 JWTs, and the encrypted
 * fixture is real AES-256-GCM — so a token with a valid shape but
 * a bad signature, or a cookie minted for another slug, is rejected
 * by the code under test rather than by a mock.
 *
 * This module is intentionally NOT named `*.test.ts`: it holds no
 * tests, only factories, so test discovery skips it.
 */

import {
  encrypt,
  importKey,
  packEnvelope,
  randomDataKeyBytes,
  wrapKey,
} from '../../assets/repo/val/lib/crypto.ts'
import type { MagicCodeOutcome } from '../../assets/repo/val/lib/magic-code.ts'
import { registerPageRoutes } from '../../assets/repo/val/lib/pages.ts'
import type { PageDeps } from '../../assets/repo/val/lib/pages.ts'
import { READER_COOKIE_NAME } from '../../assets/repo/val/lib/session.ts'

export const JWT_SECRET = 'test-jwt-secret'

export const ADMIN_TOKEN = 'test-admin-token'

export const ALLOWED_DOMAINS = ['socket.dev']

/**
 * The magic code the fake `consumeMagicCode` accepts. Anything
 * else comes back as an invalid-code refusal, exactly as the real
 * table would answer.
 */
export const GOOD_CODE = '123456'

const BLOB_KEY_BYTES = new Uint8Array(32).fill(0x3c)

export type TestContext = {
  req: {
    header: (name: string) => string | null
    json: () => Promise<unknown>
    param: (name: string) => string | undefined
    query: (name: string) => string | undefined
  }
  header: (name: string, value: string) => void
  html: (body: string, status?: number | undefined) => Response
  json: (body: unknown, status?: number | undefined) => Response
  redirect: (location: string, status?: number | undefined) => Response
  text: (body: string, status?: number | undefined) => Response
}

export type Route = {
  handler: (c: TestContext) => Promise<Response> | Response
  method: string
  pattern: string[]
}

export type RequestSpec = {
  bearer?: string | undefined
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- fleet optional-explicit-undefined convention: the explicit | undefined on an optional is intentional, not redundant.
  body?: unknown | undefined
  cookie?: string | undefined
  method?: string | undefined
}

/**
 * Match one path against a pattern, returning the captured params
 * or undefined when the shapes differ.
 */
export function matchRoute(
  pattern: string[],
  segments: string[],
): Record<string, string> | undefined {
  if (pattern.length !== segments.length) {
    return undefined
  }
  const params: Record<string, string> = Object.create(null)
  for (let i = 0, { length } = pattern; i < length; i += 1) {
    const expected = pattern[i]!
    const actual = segments[i]!
    if (expected.startsWith(':')) {
      if (!actual) {
        return undefined
      }
      params[expected.slice(1)] = decodeURIComponent(actual)
      continue
    }
    if (expected !== actual) {
      return undefined
    }
  }
  return params
}

/**
 * Mini Hono — enough surface for `registerPageRoutes` plus
 * `:param` extraction, which the admin doubles' exact-pathname
 * matcher does not do. Segment counts are compared exactly, so
 * `/:slug/` and `/:slug` stay distinct routes the way Hono treats
 * them.
 */
export function makePageApp() {
  const routes: Route[] = []
  const register =
    (method: string) => (route: string, handler: Route['handler']) => {
      routes.push({ handler, method, pattern: route.split('/') })
      return app
    }
  const app = {
    delete: register('DELETE'),
    get: register('GET'),
    patch: register('PATCH'),
    post: register('POST'),
    async dispatch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const segments = url.pathname.split('/')
      for (let i = 0, { length } = routes; i < length; i += 1) {
        const route = routes[i]!
        if (route.method !== req.method) {
          continue
        }
        const params = matchRoute(route.pattern, segments)
        if (!params) {
          continue
        }
        const responseHeaders: Record<string, string> = Object.create(null)
        const respond = (
          body: string,
          status: number | undefined,
          contentType: string,
        ) =>
          new Response(body, {
            status: status ?? 200,
            headers: { ...responseHeaders, 'content-type': contentType },
          })
        const ctx: TestContext = {
          req: {
            header: (name: string) => req.headers.get(name),
            json: () => req.clone().json(),
            param: (name: string) => params[name],
            query: (name: string) => url.searchParams.get(name) ?? undefined,
          },
          header: (name: string, value: string) => {
            responseHeaders[name] = value
          },
          html: (body, status) => respond(body, status, 'text/html'),
          json: (body, status) =>
            respond(JSON.stringify(body), status, 'application/json'),
          redirect: (location, status) =>
            new Response('', {
              status: status ?? 302,
              headers: { ...responseHeaders, location },
            }),
          text: (body, status) => respond(body, status, 'text/plain'),
        }
        return route.handler(ctx)
      }
      return new Response('not found', { status: 404 })
    },
  }
  return app
}

/**
 * The blob wrapping key the encrypted fixtures are sealed under.
 */
export async function blobWrappingKey(): Promise<CryptoKey> {
  return importKey(BLOB_KEY_BYTES)
}

/**
 * Seal HTML the way `meander publish` does with `encryptBlobs: true`.
 */
export async function encryptedBlob(html: string): Promise<string> {
  const wrapping = await blobWrappingKey()
  const dekBytes = randomDataKeyBytes()
  const dek = await importKey(dekBytes)
  return packEnvelope(
    await encrypt(html, dek),
    await wrapKey(dekBytes, wrapping),
  )
}

/**
 * Build a `Cookie` request header carrying a reader token.
 */
export function readerCookieHeader(token: string): string {
  return `${READER_COOKIE_NAME}=${token}`
}

export type PageHarnessOptions = {
  adminToken?: string | undefined
  allowedDomains?: readonly string[] | undefined
  /**
   * Blob contents keyed relative to the out-dir, e.g.
   * `private/index.html`.
   */
  blobs?: Record<string, string> | undefined
  jwtSecret?: string | undefined
  /**
   * When false the val has no `MEANDER_BLOB_KEY`, which is how a
   * deployment that never opted into blob encryption looks.
   */
  withBlobKey?: boolean | undefined
}

/**
 * Wire the real page routes against fakes. `visit()` dispatches
 * through the app the same way Val Town's runtime would.
 */
export function makePageHarness(options: PageHarnessOptions = {}) {
  const opts = { __proto__: null, ...options } as PageHarnessOptions
  const blobs = new Map<string, string>(Object.entries(opts.blobs ?? {}))
  const blobReads: string[] = []
  const deps: PageDeps = {
    adminToken: opts.adminToken ?? ADMIN_TOKEN,
    allowedDomains: opts.allowedDomains ?? ALLOWED_DOMAINS,
    blobKey: () => (opts.withBlobKey === false ? undefined : blobWrappingKey()),
    consumeMagicCode: async (_email, code): Promise<MagicCodeOutcome> =>
      code === GOOD_CODE
        ? { ok: true }
        : { ok: false, error: 'invalid code', status: 401 },
    jwtSecret: opts.jwtSecret ?? JWT_SECRET,
    listSlugs: async () => {
      const slugs = new Set<string>()
      for (const key of blobs.keys()) {
        const slash = key.indexOf('/')
        if (slash > 0) {
          slugs.add(key.slice(0, slash))
        }
      }
      return [...slugs].toSorted()
    },
    readBlobText: async relativeKey => {
      blobReads.push(relativeKey)
      return blobs.get(relativeKey)
    },
  }
  const app = makePageApp()
  registerPageRoutes(app as never, deps)
  return {
    app,
    blobReads: () => blobReads.slice(),
    blobs,
    deps,
    visit: (path: string, spec: RequestSpec = {}) => {
      const req = { __proto__: null, ...spec } as RequestSpec
      const headers: Record<string, string> = {}
      if (req.bearer) {
        headers['authorization'] = `Bearer ${req.bearer}`
      }
      if (req.cookie) {
        headers['cookie'] = req.cookie
      }
      const init: RequestInit = { headers, method: req.method ?? 'GET' }
      if (req.body !== undefined) {
        init.body = JSON.stringify(req.body)
        headers['content-type'] = 'application/json'
      }
      return app.dispatch(new Request(`http://localhost${path}`, init))
    },
  }
}
