/**
 * Caller identity for the val: who is asking, and with which
 * credential. Pure — no val-town imports — so Node tests drive it
 * directly.
 *
 * Two credentials, deliberately not interchangeable:
 *
 * - Session token (`scope: "session"`). Minted by the magic-code flow, held in
 *   the browser's localStorage, sent as `Authorization: Bearer` by the comment
 *   client's `fetch` calls. Authorizes the comment API across every slug on the
 *   deployment.
 * - Reader token (`scope: "read"`, `slug: "<slug>"`). Minted when a reader signs
 *   in on an encrypted walkthrough, delivered as an `HttpOnly` cookie, and sent
 *   automatically by the browser on a top-level navigation. Authorizes reading
 *   ONE walkthrough's pages.
 *
 * The `scope` claim keeps them apart in both directions:
 * `readSessionToken` refuses a reader token presented as a bearer,
 * and `readReaderToken` refuses a session token stuffed into the
 * cookie. Both are signed with `MEANDER_JWT_SECRET`, so rotating
 * that secret revokes every credential of both kinds at once.
 *
 * Cookie shape (see docs/encryption.md for the reasoning):
 * `HttpOnly` — page reads never need the value in JS, so an XSS
 * cannot lift it; `Secure` — Val Town is HTTPS-only, so there is no
 * plaintext hop to leak it on; `SameSite=Lax` — the cookie must
 * ride a top-level navigation from an external link (that is the
 * whole point), while staying off cross-site POSTs and subresource
 * loads; `Path=/<slug>/` — the browser never transmits walkthrough
 * A's cookie on a request for walkthrough B.
 */

import { identityGate } from './auth.ts'
import { signJwt, verifyJwt } from './jwt.ts'

export const READER_COOKIE_NAME = 'meander_read'

export const READER_SCOPE = 'read'

export const SESSION_SCOPE = 'session'

/**
 * Reader cookies live 7 days. They ride every navigation to the
 * walkthrough, so a shorter life bounds what a stolen cookie is
 * worth; a longer one would spare the reader a sign-in they only
 * face once a week.
 */
export const READER_TTL_SECONDS = 60 * 60 * 24 * 7

/**
 * Session tokens live 30 days: they sit in localStorage behind the
 * comment composer, where a mid-review re-authentication costs a
 * half-written comment.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

/**
 * The slice of a request the identity resolver reads. Hono's
 * `c.req` satisfies it, and so does a test double built on
 * `Request.headers.get` (which answers `null`, not `undefined`).
 */
export type RequestHeaders = {
  header: (name: string) => string | null | undefined
}

export type ReaderAccessConfig = {
  /**
   * The val's `MEANDER_ADMIN_TOKEN`. Empty means no caller can
   * present admin credentials.
   */
  adminToken: string
  allowedDomains: readonly string[]
  /**
   * `MEANDER_JWT_SECRET`. Empty means no token verifies, so every
   * caller falls through to the unauthenticated branch.
   */
  jwtSecret: string
}

export type ReaderAccess = {
  /**
   * The verified email behind the grant, or undefined for a
   * refusal. An admin token also resolves to undefined, since it
   * carries no identity.
   */
  email: string | undefined
  granted: boolean
  /**
   * Why the caller was refused, in the shape the login page and the
   * JSON error body both render. Empty when granted.
   */
  reason: string
  status: 401 | 403
  via: 'admin' | 'bearer' | 'cookie' | undefined
}

/**
 * Read the token out of `Authorization: Bearer <token>`, or
 * undefined when the header is absent or shaped differently.
 */
export function bearerToken(headers: RequestHeaders): string | undefined {
  const auth = headers.header('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1] : undefined
}

/**
 * A `Set-Cookie` value that expires the reader cookie for `slug`.
 * `Path` must match the value used when setting it or the browser
 * keeps the original.
 */
export function clearedReaderCookie(slug: string): string {
  return [
    `${READER_COOKIE_NAME}=`,
    `Path=${readerCookiePath(slug)}`,
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ')
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

/**
 * Mint a reader token bound to one slug. The `slug` claim is the
 * authorization decision; the cookie's `Path` is the transport
 * scoping that keeps the browser from offering it elsewhere.
 */
export async function mintReaderToken(
  email: string,
  slug: string,
  secret: string,
  ttlSeconds: number = READER_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    { email, slug, scope: READER_SCOPE, iat: now, exp: now + ttlSeconds },
    secret,
  )
}

/**
 * Mint a comment-API session token for `email`.
 */
export async function mintSessionToken(
  email: string,
  secret: string,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt(
    { email, scope: SESSION_SCOPE, iat: now, exp: now + ttlSeconds },
    secret,
  )
}

/**
 * Parse a `Cookie` request header into a null-prototype map. A
 * malformed pair (no `=`) is skipped rather than throwing: the
 * header is attacker-controlled and one bad pair must not take the
 * request down.
 */
export function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const out = Object.create(null) as Record<string, string>
  if (!header) {
    return out
  }
  const pairs = header.split(';')
  for (let i = 0, { length } = pairs; i < length; i += 1) {
    const pair = pairs[i]!
    const eq = pair.indexOf('=')
    if (eq < 1) {
      continue
    }
    const name = pair.slice(0, eq).trim()
    if (!name) {
      continue
    }
    out[name] = pair.slice(eq + 1).trim()
  }
  return out
}

/**
 * Verify a reader token and return the email it carries, or
 * undefined when the signature fails, the token expired, the scope
 * is not `read`, or the `slug` claim names a different walkthrough.
 */
export async function readReaderToken(
  token: string,
  slug: string,
  secret: string,
): Promise<string | undefined> {
  if (!secret) {
    return undefined
  }
  const payload = await verifyJwt(token, secret)
  if (
    !payload ||
    payload['scope'] !== READER_SCOPE ||
    payload['slug'] !== slug ||
    typeof payload['email'] !== 'string'
  ) {
    return undefined
  }
  return payload['email']
}

/**
 * Verify a comment-API session token and return the email it
 * carries, or undefined when the signature fails, the token
 * expired, or the scope is not `session`. A reader cookie replayed
 * as a bearer fails that last check.
 */
export async function readSessionToken(
  token: string,
  secret: string,
): Promise<string | undefined> {
  if (!secret) {
    return undefined
  }
  const payload = await verifyJwt(token, secret)
  if (
    !payload ||
    payload['scope'] !== SESSION_SCOPE ||
    typeof payload['email'] !== 'string'
  ) {
    return undefined
  }
  return payload['email']
}

/**
 * The `Set-Cookie` value that grants read access to `slug`.
 */
export function readerCookie(
  token: string,
  slug: string,
  ttlSeconds: number = READER_TTL_SECONDS,
): string {
  return [
    `${READER_COOKIE_NAME}=${token}`,
    `Path=${readerCookiePath(slug)}`,
    `Max-Age=${ttlSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ')
}

/**
 * The cookie `Path` for a slug. Every gated page for the
 * walkthrough lives under it — `/<slug>/`, `/<slug>/documents`,
 * `/<slug>/part/<id>` — and nothing else does.
 */
export function readerCookiePath(slug: string): string {
  return `/${slug}/`
}

/**
 * Decide whether the caller may read encrypted walkthrough `slug`.
 *
 * Three credentials are accepted, in this order: the val's admin
 * token, the slug's reader cookie, then a comment-API session
 * token on the `Authorization` header. A headless mirror or a
 * smoke check reaches a private page with the first, a browser
 * with the second, an API client with the third. The last two are
 * re-checked against the domain allowlist on every request, so
 * dropping a domain from `MEANDER_ALLOWED_EMAIL_DOMAINS` revokes
 * credentials already issued to it.
 */
export async function resolveReaderAccess(
  headers: RequestHeaders,
  slug: string,
  config: ReaderAccessConfig,
): Promise<ReaderAccess> {
  const cfg = { __proto__: null, ...config } as ReaderAccessConfig
  const presented = bearerToken(headers)
  if (
    cfg.adminToken &&
    presented !== undefined &&
    constantTimeEqual(presented, cfg.adminToken)
  ) {
    return {
      email: undefined,
      granted: true,
      reason: '',
      status: 401,
      via: 'admin',
    }
  }
  const cookies = parseCookieHeader(headers.header('cookie'))
  const cookieValue = cookies[READER_COOKIE_NAME]
  const cookieEmail = cookieValue
    ? await readReaderToken(cookieValue, slug, cfg.jwtSecret)
    : undefined
  const bearerEmail =
    !cookieEmail && presented !== undefined
      ? await readSessionToken(presented, cfg.jwtSecret)
      : undefined
  const email = cookieEmail ?? bearerEmail
  const denied = identityGate(
    email,
    cfg.allowedDomains,
    'reading this walkthrough',
  )
  if (denied) {
    return {
      email: undefined,
      granted: false,
      reason: denied.error,
      status: denied.status,
      via: undefined,
    }
  }
  return {
    email,
    granted: true,
    reason: '',
    status: 401,
    via: cookieEmail ? 'cookie' : 'bearer',
  }
}
