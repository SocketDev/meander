/**
 * @file Reader gating for the val's walkthrough page routes
 *   (assets/val/lib/pages.ts). A walkthrough is private exactly when its blob
 *   is envelope-encrypted, so the first thing pinned here is the case a
 *   mistaken gate would break loudest: a plaintext walkthrough still serves to
 *   an anonymous visitor. The rest is the allow/deny matrix on an encrypted
 *   one — no cookie, expired cookie, forged signature, cookie minted for
 *   another slug, scope-confused credentials, a valid cookie, a session
 *   bearer, and the admin token.
 *   Nothing is stubbed below the gate: the fixtures are real AES-256-GCM
 *   envelopes and the cookies are real HS256 JWTs, so removing the
 *   `resolveReaderAccess` call from `serveWalkthroughPage` turns the deny
 *   cases red rather than leaving them passing against a mock.
 *   Doubles: ./page-test-doubles.ts.
 */

import { describe, expect, it } from 'vitest'

import { signJwt } from '../../assets/val/lib/jwt.ts'
import {
  mintReaderToken,
  mintSessionToken,
  READER_SCOPE,
} from '../../assets/val/lib/session.ts'
import {
  ADMIN_TOKEN,
  encryptedBlob,
  JWT_SECRET,
  makePageHarness,
  readerCookieHeader,
} from './page-test-doubles.ts'

const PRIVATE_HTML = '<!doctype html><title>private prose</title>'
const PUBLIC_HTML = '<!doctype html><title>public prose</title>'

async function privateHarness() {
  return makePageHarness({
    blobs: {
      'private/index.html': await encryptedBlob(PRIVATE_HTML),
      'private/documents.html': await encryptedBlob(PRIVATE_HTML),
      'private/part-2.html': await encryptedBlob(PRIVATE_HTML),
      'open/index.html': PUBLIC_HTML,
      'open/part-2.html': PUBLIC_HTML,
    },
  })
}

async function readerCookieFor(slug: string, email = 'a@socket.dev') {
  return readerCookieHeader(await mintReaderToken(email, slug, JWT_SECRET))
}

describe('a walkthrough published in plaintext stays public', () => {
  it('serves /:slug/ to an anonymous visitor', async () => {
    const h = await privateHarness()
    const res = await h.visit('/open/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PUBLIC_HTML)
  })

  it('serves /:slug/part/:id to an anonymous visitor', async () => {
    const h = await privateHarness()
    const res = await h.visit('/open/part/2')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PUBLIC_HTML)
  })

  it('serves it on a val with no blob key at all', async () => {
    const h = makePageHarness({
      blobs: { 'open/index.html': PUBLIC_HTML },
      withBlobKey: false,
    })
    const res = await h.visit('/open/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PUBLIC_HTML)
  })

  it('serves it on a val with no allowed email domains', async () => {
    const h = makePageHarness({
      allowedDomains: [],
      blobs: { 'open/index.html': PUBLIC_HTML },
    })
    const res = await h.visit('/open/')
    expect(res.status).toBe(200)
  })
})

describe('an encrypted walkthrough refuses an unproven caller', () => {
  it('answers 401 with the sign-in page and no plaintext', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private/')
    expect(res.status).toBe(401)
    const body = await res.text()
    expect(body).toContain('private walkthrough')
    expect(body).toContain('meander-login-form')
    expect(body).toContain('authentication required')
    expect(body).not.toContain('private prose')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('refuses an expired reader cookie', async () => {
    const h = await privateHarness()
    const stale = await mintReaderToken(
      'a@socket.dev',
      'private',
      JWT_SECRET,
      -60,
    )
    const res = await h.visit('/private/', {
      cookie: readerCookieHeader(stale),
    })
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('private prose')
  })

  it('refuses a cookie whose signature does not verify', async () => {
    const h = await privateHarness()
    /* Same claims a real reader cookie carries, so the signature
     * is the only thing wrong with it. */
    const forged = await signJwt(
      {
        email: 'a@socket.dev',
        slug: 'private',
        scope: READER_SCOPE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      'not-the-secret',
    )
    expect(forged.split('.')).toHaveLength(3)
    const res = await h.visit('/private/', {
      cookie: readerCookieHeader(forged),
    })
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('private prose')
  })

  it('refuses a valid cookie minted for a different walkthrough', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private/', {
      cookie: await readerCookieFor('open'),
    })
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('private prose')
  })

  it('refuses a comment-API session token stuffed into the cookie', async () => {
    const h = await privateHarness()
    const session = await mintSessionToken('a@socket.dev', JWT_SECRET)
    const res = await h.visit('/private/', {
      cookie: readerCookieHeader(session),
    })
    expect(res.status).toBe(401)
  })

  it('refuses a reader token replayed as an Authorization bearer', async () => {
    const h = await privateHarness()
    const reader = await mintReaderToken('a@socket.dev', 'private', JWT_SECRET)
    const res = await h.visit('/private/', { bearer: reader })
    expect(res.status).toBe(401)
  })

  it('refuses a session on a domain outside the allowlist with 403', async () => {
    const h = await privateHarness()
    const session = await mintSessionToken('outsider@elsewhere.dev', JWT_SECRET)
    const res = await h.visit('/private/', { bearer: session })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('email domain not allowed')
  })

  it('refuses a cookie whose domain has since left the allowlist', async () => {
    const cookie = await readerCookieFor('private')
    const h = makePageHarness({
      allowedDomains: ['elsewhere.dev'],
      blobs: { 'private/index.html': await encryptedBlob(PRIVATE_HTML) },
    })
    const res = await h.visit('/private/', { cookie })
    expect(res.status).toBe(403)
  })

  it('refuses a wrong admin token', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private/', { bearer: 'not-the-admin-token' })
    expect(res.status).toBe(401)
  })

  it('gates /:slug/documents the same way', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private/documents')
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('private prose')
  })

  it('gates /:slug/part/:id the same way', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private/part/2')
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('private prose')
  })
})

describe('an encrypted walkthrough serves a proven caller', () => {
  it('accepts the slug reader cookie', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private/', {
      cookie: await readerCookieFor('private'),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PRIVATE_HTML)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('accepts a comment-API session token on an allowed domain', async () => {
    const h = await privateHarness()
    const session = await mintSessionToken('a@socket.dev', JWT_SECRET)
    const res = await h.visit('/private/', { bearer: session })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PRIVATE_HTML)
  })

  it('accepts the val admin token', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private/', { bearer: ADMIN_TOKEN })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PRIVATE_HTML)
  })

  it('serves the documents page', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private/documents', {
      cookie: await readerCookieFor('private'),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PRIVATE_HTML)
  })

  it('serves a part page', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private/part/2', {
      cookie: await readerCookieFor('private'),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PRIVATE_HTML)
  })
})

describe('serving failures stay distinguishable from refusals', () => {
  it('answers 404 for a slug with no blob', async () => {
    const h = await privateHarness()
    const res = await h.visit('/missing/')
    expect(res.status).toBe(404)
  })

  it('answers 500 when the blob is encrypted but the val has no key', async () => {
    const h = makePageHarness({
      blobs: { 'private/index.html': await encryptedBlob(PRIVATE_HTML) },
      withBlobKey: false,
    })
    const res = await h.visit('/private/', { bearer: ADMIN_TOKEN })
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('MEANDER_BLOB_KEY is unset')
  })

  it('refuses before reporting a missing key, so 500 never leaks to strangers', async () => {
    const h = makePageHarness({
      blobs: { 'private/index.html': await encryptedBlob(PRIVATE_HTML) },
      withBlobKey: false,
    })
    const res = await h.visit('/private/')
    expect(res.status).toBe(401)
  })

  it('answers 500 for a malformed envelope header', async () => {
    const h = makePageHarness({
      blobs: { 'private/index.html': 'ENVELOPE:9:garbage' },
    })
    const res = await h.visit('/private/', { bearer: ADMIN_TOKEN })
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('malformed encrypted blob')
  })

  it('redirects /:slug to /:slug/ without consulting the gate', async () => {
    const h = await privateHarness()
    const res = await h.visit('/private')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/private/')
  })
})
