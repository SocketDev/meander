/**
 * @file Tests for assets/val/lib/session.ts — the credential layer under
 *   reader gating. Two things are pinned here: the cookie parser (fed
 *   attacker-shaped headers), and the scope/slug binding that keeps a
 *   comment-API session token and a walkthrough reader token from standing in
 *   for each other.
 */

import { describe, expect, it } from 'vitest'

import { signJwt } from '../../assets/repo/val/lib/jwt.ts'
import {
  bearerToken,
  clearedReaderCookie,
  constantTimeEqual,
  mintReaderToken,
  mintSessionToken,
  parseCookieHeader,
  READER_COOKIE_NAME,
  READER_SCOPE,
  readerCookie,
  readerCookiePath,
  readReaderToken,
  readSessionToken,
  resolveReaderAccess,
  SESSION_SCOPE,
} from '../../assets/repo/val/lib/session.ts'

const SECRET = 'test-jwt-secret'

function headersWith(values: Record<string, string>) {
  return {
    header: (name: string) => values[name.toLowerCase()],
  }
}

describe('parseCookieHeader', () => {
  it('reads a single pair', () => {
    expect(parseCookieHeader('meander_read=abc')).toEqual({
      meander_read: 'abc',
    })
  })

  it('reads several pairs and trims whitespace', () => {
    expect(parseCookieHeader('a=1; meander_read=xyz ;  b=2')).toEqual({
      a: '1',
      meander_read: 'xyz',
      b: '2',
    })
  })

  it('returns an empty map for an absent header', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
    // oxlint-disable-next-line socket/prefer-undefined-over-null -- Request.headers.get answers null, which is what the val receives.
    expect(parseCookieHeader(null)).toEqual({})
    expect(parseCookieHeader('')).toEqual({})
  })

  it('skips malformed pairs instead of throwing', () => {
    expect(parseCookieHeader('novalue; =orphan; good=1')).toEqual({ good: '1' })
  })

  it('keeps a value containing "=" intact', () => {
    expect(parseCookieHeader('t=a.b.c==')).toEqual({ t: 'a.b.c==' })
  })

  it('produces a null-prototype map, so a "__proto__" cookie is inert', () => {
    const parsed = parseCookieHeader('__proto__=polluted')
    expect(Object.getPrototypeOf(parsed)).toBe(null)
    expect(Object.getOwnPropertyNames(parsed)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })
})

describe('bearerToken', () => {
  it('reads the token out of an Authorization header', () => {
    expect(bearerToken(headersWith({ authorization: 'Bearer abc' }))).toBe(
      'abc',
    )
  })

  it('is case-insensitive on the scheme', () => {
    expect(bearerToken(headersWith({ authorization: 'bearer abc' }))).toBe(
      'abc',
    )
  })

  it('answers undefined for a missing or non-bearer header', () => {
    expect(bearerToken(headersWith({}))).toBeUndefined()
    expect(
      bearerToken(headersWith({ authorization: 'Basic abc' })),
    ).toBeUndefined()
  })
})

describe('constantTimeEqual', () => {
  it('matches identical strings and rejects everything else', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('', 'a')).toBe(false)
  })
})

describe('reader cookie shape', () => {
  it('is HttpOnly, Secure, SameSite=Lax, and scoped to the slug path', () => {
    const cookie = readerCookie('tok', 'alpha')
    expect(cookie).toContain(`${READER_COOKIE_NAME}=tok`)
    expect(cookie).toContain('Path=/alpha/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=604800')
  })

  it('clears with a matching path and a zero max-age', () => {
    const cleared = clearedReaderCookie('alpha')
    expect(cleared).toContain(`Path=${readerCookiePath('alpha')}`)
    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('HttpOnly')
  })
})

describe('token scope binding', () => {
  it('round-trips a reader token for its own slug', async () => {
    const token = await mintReaderToken('a@socket.dev', 'alpha', SECRET)
    expect(await readReaderToken(token, 'alpha', SECRET)).toBe('a@socket.dev')
  })

  it('refuses a reader token presented for another slug', async () => {
    const token = await mintReaderToken('a@socket.dev', 'alpha', SECRET)
    expect(await readReaderToken(token, 'beta', SECRET)).toBeUndefined()
  })

  it('refuses a reader token signed with another secret', async () => {
    const token = await mintReaderToken('a@socket.dev', 'alpha', 'other-secret')
    expect(await readReaderToken(token, 'alpha', SECRET)).toBeUndefined()
  })

  it('refuses an expired reader token', async () => {
    const token = await mintReaderToken('a@socket.dev', 'alpha', SECRET, -60)
    expect(await readReaderToken(token, 'alpha', SECRET)).toBeUndefined()
  })

  it('refuses a session token used as a reader cookie', async () => {
    const token = await mintSessionToken('a@socket.dev', SECRET)
    expect(await readReaderToken(token, 'alpha', SECRET)).toBeUndefined()
  })

  it('refuses a reader token used as a session bearer', async () => {
    const token = await mintReaderToken('a@socket.dev', 'alpha', SECRET)
    expect(await readSessionToken(token, SECRET)).toBeUndefined()
  })

  it('refuses a scope-less token on both readers', async () => {
    const token = await signJwt({ email: 'a@socket.dev' }, SECRET)
    expect(await readSessionToken(token, SECRET)).toBeUndefined()
    expect(await readReaderToken(token, 'alpha', SECRET)).toBeUndefined()
  })

  it('refuses every token when the val has no JWT secret', async () => {
    const token = await mintSessionToken('a@socket.dev', SECRET)
    expect(await readSessionToken(token, '')).toBeUndefined()
    expect(await readReaderToken(token, 'alpha', '')).toBeUndefined()
  })

  it('names the scopes it binds to', () => {
    expect(READER_SCOPE).toBe('read')
    expect(SESSION_SCOPE).toBe('session')
  })
})

describe('resolveReaderAccess', () => {
  const config = {
    adminToken: 'admin-tok',
    allowedDomains: ['socket.dev'],
    jwtSecret: SECRET,
  }

  it('grants the admin token without an identity', async () => {
    const access = await resolveReaderAccess(
      headersWith({ authorization: 'Bearer admin-tok' }),
      'alpha',
      config,
    )
    expect(access.granted).toBe(true)
    expect(access.via).toBe('admin')
    expect(access.email).toBeUndefined()
  })

  it('never treats an empty admin token as a match', async () => {
    const access = await resolveReaderAccess(
      headersWith({ authorization: 'Bearer ' }),
      'alpha',
      { ...config, adminToken: '' },
    )
    expect(access.granted).toBe(false)
  })

  it('grants a reader cookie for the slug', async () => {
    const token = await mintReaderToken('a@socket.dev', 'alpha', SECRET)
    const access = await resolveReaderAccess(
      headersWith({ cookie: `${READER_COOKIE_NAME}=${token}` }),
      'alpha',
      config,
    )
    expect(access.granted).toBe(true)
    expect(access.via).toBe('cookie')
    expect(access.email).toBe('a@socket.dev')
  })

  it('grants a session bearer on an allowed domain', async () => {
    const token = await mintSessionToken('a@socket.dev', SECRET)
    const access = await resolveReaderAccess(
      headersWith({ authorization: `Bearer ${token}` }),
      'alpha',
      config,
    )
    expect(access.granted).toBe(true)
    expect(access.via).toBe('bearer')
  })

  it('refuses an anonymous caller with 401', async () => {
    const access = await resolveReaderAccess(headersWith({}), 'alpha', config)
    expect(access.granted).toBe(false)
    expect(access.status).toBe(401)
    expect(access.reason).toBe('authentication required')
  })

  it('refuses an identity whose domain left the allowlist with 403', async () => {
    const token = await mintReaderToken('a@socket.dev', 'alpha', SECRET)
    const access = await resolveReaderAccess(
      headersWith({ cookie: `${READER_COOKIE_NAME}=${token}` }),
      'alpha',
      { ...config, allowedDomains: ['elsewhere.dev'] },
    )
    expect(access.granted).toBe(false)
    expect(access.status).toBe(403)
    expect(access.reason).toBe('email domain not allowed')
  })

  it('falls through to the bearer when the cookie is for another slug', async () => {
    const stale = await mintReaderToken('a@socket.dev', 'beta', SECRET)
    const session = await mintSessionToken('a@socket.dev', SECRET)
    const access = await resolveReaderAccess(
      headersWith({
        authorization: `Bearer ${session}`,
        cookie: `${READER_COOKIE_NAME}=${stale}`,
      }),
      'alpha',
      config,
    )
    expect(access.granted).toBe(true)
    expect(access.via).toBe('bearer')
  })
})
