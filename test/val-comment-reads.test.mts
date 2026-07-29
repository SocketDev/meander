/**
 * @file Reader-gate coverage for the val's comment read routes
 *   (GET /:slug/api/comments and GET /:slug/api/comments/unresolved).
 *   Harness: test/utils/val-comment-harness.mts.
 *   Both routes hand back decrypted bodies and author identities, so
 *   on an encrypted walkthrough they accept the same three
 *   credentials the prose does. On a public walkthrough they accept
 *   everyone — that is the common case and the regression a mistaken
 *   gate would cause, so it is asserted first and for both routes.
 */

import { describe, expect, it } from 'vitest'

import {
  ADMIN_TOKEN,
  DELETE_ROUTE,
  makeHarness,
  makeRow,
  PATCH_ROUTE,
  READ_ROUTE,
  readerCookieFor,
  sessionFor,
  UNRESOLVED_ROUTE,
} from './utils/val-comment-harness.mts'
import { mintReaderToken } from '../assets/val/lib/session.ts'

async function harnessWithComment(
  options: Parameters<typeof makeHarness>[0] = {},
) {
  const h = await makeHarness(options)
  h.sqlite.rows = [
    await makeRow({
      id: 'c1',
      slug: 'alpha',
      author: 'a@socket.dev',
      body: 'visible',
    }),
  ]
  return h
}

/* ------------------------------------------------------------------ */
/*  A public walkthrough stays open                                     */
/* ------------------------------------------------------------------ */

describe('a public walkthrough', () => {
  it('serves a part to an anonymous visitor', async () => {
    const h = await harnessWithComment()
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
    })
    expect(res.status).toBe(200)
    const comments = res.body as Array<Record<string, unknown>>
    expect(comments).toHaveLength(1)
    expect(comments[0]!['body']).toBe('visible')
  })

  it('serves unresolved comments to an anonymous visitor', async () => {
    const h = await harnessWithComment()
    const res = await h.call(UNRESOLVED_ROUTE, { params: { slug: 'alpha' } })
    expect(res.status).toBe(200)
    expect(res.body as unknown[]).toHaveLength(1)
  })

  it('stays open on a deployment with an empty domain allowlist', async () => {
    const h = await harnessWithComment({ allowedDomains: [] })
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
    })
    expect(res.status).toBe(200)
  })

  it('stays open on a deployment with no JWT secret', async () => {
    const h = await harnessWithComment({ jwtSecret: '' })
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
    })
    expect(res.status).toBe(200)
  })
})

/* ------------------------------------------------------------------ */
/*  An encrypted walkthrough refuses                                    */
/* ------------------------------------------------------------------ */

describe('an encrypted walkthrough refuses a comment read', () => {
  const encrypted = { privateSlugs: ['alpha'] }

  it('with no credential at all', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
    })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'authentication required' })
  })

  it('and leaks no body in the refusal', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
    })
    expect(JSON.stringify(res.body)).not.toContain('visible')
    expect(JSON.stringify(res.body)).not.toContain('a@socket.dev')
  })

  it('with an expired reader cookie', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      cookie: await readerCookieFor('a@socket.dev', 'alpha', -60),
    })
    expect(res.status).toBe(401)
  })

  it('with a forged cookie signature', async () => {
    const h = await harnessWithComment(encrypted)
    const forged = await mintReaderToken(
      'a@socket.dev',
      'alpha',
      'not-the-val-secret',
      3600,
    )
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      cookie: `meander_read=${forged}`,
    })
    expect(res.status).toBe(401)
  })

  it("with another walkthrough's reader cookie", async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      cookie: await readerCookieFor('a@socket.dev', 'beta'),
    })
    expect(res.status).toBe(401)
  })

  it('with a reader cookie on a domain the deployment dropped', async () => {
    const h = await harnessWithComment({
      ...encrypted,
      allowedDomains: ['example.com'],
    })
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      cookie: await readerCookieFor('a@socket.dev', 'alpha'),
    })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'email domain not allowed' })
  })

  it('on the unresolved route too', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(UNRESOLVED_ROUTE, { params: { slug: 'alpha' } })
    expect(res.status).toBe(401)
  })

  it('before it validates the part parameter', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(READ_ROUTE, { params: { slug: 'alpha' } })
    expect(res.status).toBe(401)
  })
})

/* ------------------------------------------------------------------ */
/*  An encrypted walkthrough allows                                     */
/* ------------------------------------------------------------------ */

describe('an encrypted walkthrough allows a comment read', () => {
  const encrypted = { privateSlugs: ['alpha'] }

  it('with the slug reader cookie', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      cookie: await readerCookieFor('a@socket.dev', 'alpha'),
    })
    expect(res.status).toBe(200)
    expect(res.body as unknown[]).toHaveLength(1)
  })

  it('with a comment-API session bearer', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      token: await sessionFor('a@socket.dev'),
    })
    expect(res.status).toBe(200)
  })

  it('with the val admin token', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      token: ADMIN_TOKEN,
    })
    expect(res.status).toBe(200)
  })

  it('on the unresolved route with the reader cookie', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(UNRESOLVED_ROUTE, {
      params: { slug: 'alpha' },
      cookie: await readerCookieFor('a@socket.dev', 'alpha'),
    })
    expect(res.status).toBe(200)
    expect(res.body as unknown[]).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/*  Unknown slugs fail closed                                           */
/* ------------------------------------------------------------------ */

describe('a slug the deployment cannot fetch', () => {
  it('refuses an anonymous comment read', async () => {
    const h = await harnessWithComment({ missingSlugs: ['alpha'] })
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
    })
    expect(res.status).toBe(401)
  })

  it('still opens to a reader who can prove access', async () => {
    const h = await harnessWithComment({ missingSlugs: ['alpha'] })
    const res = await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      cookie: await readerCookieFor('a@socket.dev', 'alpha'),
    })
    expect(res.status).toBe(200)
  })
})

/* ------------------------------------------------------------------ */
/*  Cost                                                                */
/* ------------------------------------------------------------------ */

describe('the recorded flag', () => {
  it('probes the blob store once, then answers from the record', async () => {
    const h = await harnessWithComment({ privateSlugs: ['alpha'] })
    const cookie = await readerCookieFor('a@socket.dev', 'alpha')
    await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      cookie,
    })
    await h.call(READ_ROUTE, {
      params: { slug: 'alpha' },
      query: { part: '1' },
      cookie,
    })
    await h.call(UNRESOLVED_ROUTE, { params: { slug: 'alpha' }, cookie })
    expect(h.blobReads()).toEqual(['alpha/index.html'])
    expect(h.sqlite.visibility.get('alpha')).toBe(1)
  })
})

/* ------------------------------------------------------------------ */
/*  Writes are not double-gated                                         */
/* ------------------------------------------------------------------ */

describe('an author with a session but no reader cookie', () => {
  const encrypted = { privateSlugs: ['alpha'] }

  it('posts a comment to an encrypted walkthrough', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call('POST /:slug/api/comments', {
      params: { slug: 'alpha' },
      token: await sessionFor('a@socket.dev'),
      body: { part: 1, file: 'src/index.ts', lineFrom: 3, body: 'a remark' },
    })
    expect(res.status).toBe(201)
  })

  it('resolves their own comment on an encrypted walkthrough', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(PATCH_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: await sessionFor('a@socket.dev'),
      body: { resolved: true },
    })
    expect(res.status).toBe(200)
    expect(h.sqlite.rows[0]!.resolved).toBe(1)
  })

  it('deletes their own comment on an encrypted walkthrough', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call(DELETE_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: await sessionFor('a@socket.dev'),
    })
    expect(res.status).toBe(200)
    expect(h.sqlite.rows).toHaveLength(0)
  })

  it('exports an encrypted walkthrough', async () => {
    const h = await harnessWithComment(encrypted)
    const res = await h.call('GET /:slug/api/comments/export', {
      params: { slug: 'alpha' },
      token: await sessionFor('a@socket.dev'),
    })
    expect(res.status).toBe(200)
    expect(res.body as unknown[]).toHaveLength(1)
  })
})
