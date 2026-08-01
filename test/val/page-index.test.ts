/**
 * @file The val's slug index and the reader sign-in that unlocks an encrypted
 *   walkthrough (assets/val/lib/pages.ts). The index must keep advertising
 *   public walkthroughs to everyone while omitting private ones from a caller
 *   who cannot open them, and the sign-in route must hand back a cookie that
 *   really does unlock the page — which the end-to-end case at the bottom
 *   drives through both routes rather than asserting on the cookie's text.
 *   Doubles: ./page-test-doubles.ts.
 */

import { describe, expect, it } from 'vitest'

import {
  mintReaderToken,
  mintSessionToken,
} from '../../assets/val/lib/session.ts'
import {
  ADMIN_TOKEN,
  encryptedBlob,
  GOOD_CODE,
  JWT_SECRET,
  makePageHarness,
  readerCookieHeader,
} from './page-test-doubles.ts'

const PRIVATE_HTML = '<!doctype html><title>private prose</title>'
const PUBLIC_HTML = '<!doctype html><title>public prose</title>'

async function mixedHarness() {
  return makePageHarness({
    blobs: {
      'private/index.html': await encryptedBlob(PRIVATE_HTML),
      'open/index.html': PUBLIC_HTML,
    },
  })
}

/**
 * The `Cookie` request header a browser would send back after a
 * `Set-Cookie` response.
 */
function cookieFromResponse(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  return setCookie.split(';')[0]!
}

describe('GET / lists what the caller can open', () => {
  it('lists a public walkthrough and omits a private one for a stranger', async () => {
    const h = await mixedHarness()
    const body = await (await h.visit('/')).text()
    expect(body).toContain('href="/open/"')
    expect(body).not.toContain('href="/private/"')
  })

  it('lists both for the admin token', async () => {
    const h = await mixedHarness()
    const body = await (await h.visit('/', { bearer: ADMIN_TOKEN })).text()
    expect(body).toContain('href="/open/"')
    expect(body).toContain('href="/private/"')
  })

  it('lists both for a session token on an allowed domain', async () => {
    const h = await mixedHarness()
    const session = await mintSessionToken('a@socket.dev', JWT_SECRET)
    const body = await (await h.visit('/', { bearer: session })).text()
    expect(body).toContain('href="/private/"')
  })

  it('omits the private one for a session on a domain outside the allowlist', async () => {
    const h = await mixedHarness()
    const session = await mintSessionToken('outsider@elsewhere.dev', JWT_SECRET)
    const body = await (await h.visit('/', { bearer: session })).text()
    expect(body).toContain('href="/open/"')
    expect(body).not.toContain('href="/private/"')
  })

  it('lists a private one for a caller who presents its reader cookie', async () => {
    const h = await mixedHarness()
    const token = await mintReaderToken('a@socket.dev', 'private', JWT_SECRET)
    const body = await (
      await h.visit('/', { cookie: readerCookieHeader(token) })
    ).text()
    expect(body).toContain('href="/private/"')
  })

  it('says nothing is available rather than nothing is published', async () => {
    const h = makePageHarness({
      blobs: { 'private/index.html': await encryptedBlob(PRIVATE_HTML) },
    })
    const body = await (await h.visit('/')).text()
    expect(body).toContain('No walkthroughs available.')
  })

  it('skips the per-slug probe entirely when the val has no blob key', async () => {
    const h = makePageHarness({
      blobs: { 'open/index.html': PUBLIC_HTML },
      withBlobKey: false,
    })
    const body = await (await h.visit('/')).text()
    expect(body).toContain('href="/open/"')
    expect(h.blobReads()).toEqual([])
  })

  it('answers 500 when the blob listing fails', async () => {
    const h = await mixedHarness()
    h.deps.listSlugs = async () => {
      throw new Error('blob store unreachable')
    }
    const res = await h.visit('/')
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Error listing walkthroughs')
  })
})

describe('POST /:slug/api/auth/session', () => {
  it('sets a slug-scoped HttpOnly cookie for a good code', async () => {
    const h = await mixedHarness()
    const res = await h.visit('/private/api/auth/session', {
      body: { email: 'a@socket.dev', code: GOOD_CODE },
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('meander_read=')
    expect(cookie).toContain('Path=/private/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('also returns the comment-API session token', async () => {
    const h = await mixedHarness()
    const res = await h.visit('/private/api/auth/session', {
      body: { email: 'a@socket.dev', code: GOOD_CODE },
      method: 'POST',
    })
    const body = (await res.json()) as { email: string; token: string }
    expect(body.email).toBe('a@socket.dev')
    expect(body.token.split('.')).toHaveLength(3)
  })

  it('refuses a wrong code and sets no cookie', async () => {
    const h = await mixedHarness()
    const res = await h.visit('/private/api/auth/session', {
      body: { email: 'a@socket.dev', code: '000000' },
      method: 'POST',
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBe(null)
  })

  it('refuses a domain outside the allowlist before touching the code', async () => {
    const h = await mixedHarness()
    const res = await h.visit('/private/api/auth/session', {
      body: { email: 'outsider@elsewhere.dev', code: GOOD_CODE },
      method: 'POST',
    })
    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBe(null)
  })

  it('refuses a request missing the email or the code', async () => {
    const h = await mixedHarness()
    const res = await h.visit('/private/api/auth/session', {
      body: { email: 'a@socket.dev' },
      method: 'POST',
    })
    expect(res.status).toBe(400)
  })

  it('refuses when the val has no JWT secret to sign with', async () => {
    const h = makePageHarness({
      blobs: { 'private/index.html': await encryptedBlob(PRIVATE_HTML) },
      jwtSecret: '',
    })
    const res = await h.visit('/private/api/auth/session', {
      body: { email: 'a@socket.dev', code: GOOD_CODE },
      method: 'POST',
    })
    expect(res.status).toBe(500)
  })
})

describe('DELETE /:slug/api/auth/session', () => {
  it('expires the cookie on the same path it was set on', async () => {
    const h = await mixedHarness()
    const res = await h.visit('/private/api/auth/session', {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('Path=/private/')
    expect(cookie).toContain('Max-Age=0')
  })
})

describe('sign-in end to end', () => {
  it('turns a refused page into a served one', async () => {
    const h = await mixedHarness()
    const refused = await h.visit('/private/')
    expect(refused.status).toBe(401)

    const signIn = await h.visit('/private/api/auth/session', {
      body: { email: 'a@socket.dev', code: GOOD_CODE },
      method: 'POST',
    })
    expect(signIn.status).toBe(200)

    const served = await h.visit('/private/', {
      cookie: cookieFromResponse(signIn),
    })
    expect(served.status).toBe(200)
    expect(await served.text()).toBe(PRIVATE_HTML)
  })

  it('does not unlock a different walkthrough', async () => {
    const h = makePageHarness({
      blobs: {
        'alpha/index.html': await encryptedBlob(PRIVATE_HTML),
        'beta/index.html': await encryptedBlob(PRIVATE_HTML),
      },
    })
    const signIn = await h.visit('/alpha/api/auth/session', {
      body: { email: 'a@socket.dev', code: GOOD_CODE },
      method: 'POST',
    })
    const cookie = cookieFromResponse(signIn)
    expect((await h.visit('/alpha/', { cookie })).status).toBe(200)
    expect((await h.visit('/beta/', { cookie })).status).toBe(401)
  })
})
