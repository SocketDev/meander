/**
 * @file Auth coverage for the val's comment export route
 *   (GET /:slug/api/comments/export). The export decrypts every body and
 *   author for a slug, so both the deny paths (anonymous, forged signature,
 *   expired token, off-allowlist domain, demo mode) and the allow paths
 *   (session, admin token) are pinned here. Harness:
 *   test/utils/val-comment-harness.mts.
 */

import { describe, expect, it } from 'vitest'

import { signJwt } from '../assets/val/lib/jwt.ts'
import { SESSION_SCOPE } from '../assets/val/lib/session.ts'
import {
  ADMIN_TOKEN,
  EXPORT_ROUTE,
  JWT_SECRET,
  makeHarness,
  makeRow,
  sessionFor,
} from './utils/val-comment-harness.mts'

describe('GET /:slug/api/comments/export', () => {
  it('denies an anonymous caller with 401', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(EXPORT_ROUTE, { params: { slug: 'alpha' } })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'authentication required' })
  })

  it('denies a forged token whose signature does not verify', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const real = await sessionFor('a@socket.dev')
    /* Same claims a real session carries, so the signature is the
     * only thing wrong with it. */
    const forged = await signJwt(
      {
        email: 'a@socket.dev',
        scope: SESSION_SCOPE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      'not-the-secret',
    )
    expect(forged.split('.')).toHaveLength(3)
    expect(forged).not.toBe(real)
    const res = await h.call(EXPORT_ROUTE, {
      params: { slug: 'alpha' },
      token: forged,
    })
    expect(res.status).toBe(401)
  })

  it('denies an expired session', async () => {
    const h = await makeHarness()
    const stale = await signJwt(
      {
        email: 'a@socket.dev',
        scope: SESSION_SCOPE,
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      JWT_SECRET,
    )
    const res = await h.call(EXPORT_ROUTE, {
      params: { slug: 'alpha' },
      token: stale,
    })
    expect(res.status).toBe(401)
  })

  it('denies a session on a domain outside the allowlist with 403', async () => {
    const h = await makeHarness()
    const res = await h.call(EXPORT_ROUTE, {
      params: { slug: 'alpha' },
      token: await sessionFor('outsider@example.com'),
    })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'email domain not allowed' })
  })

  it('names the export in the demo-mode denial', async () => {
    const h = await makeHarness({ demoMode: true })
    const res = await h.call(EXPORT_ROUTE, {
      params: { slug: 'alpha' },
      token: await sessionFor('a@socket.dev'),
    })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'demo mode — export disabled' })
  })

  it('serves the dump to an allowed session', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({
        id: 'root',
        slug: 'alpha',
        author: 'a@socket.dev',
        body: 'top level',
      }),
      await makeRow({
        id: 'reply',
        slug: 'alpha',
        author: 'b@socket.dev',
        body: 'a reply',
        parentId: 'root',
      }),
    ]
    const res = await h.call(EXPORT_ROUTE, {
      params: { slug: 'alpha' },
      token: await sessionFor('a@socket.dev'),
    })
    expect(res.status).toBe(200)
    const exported = res.body as Array<Record<string, unknown>>
    expect(exported).toHaveLength(1)
    expect(exported[0]!['content']).toBe('top level')
    expect(exported[0]!['author']).toBe('a@socket.dev')
    expect(exported[0]!['children']).toEqual([
      {
        author: 'b@socket.dev',
        datetime: new Date('2026-01-01T00:00:00.000Z').getTime(),
        content: 'a reply',
      },
    ])
    expect(res.headers['Content-Disposition']).toContain('alpha-comments.json')
  })

  it('serves the dump to the admin token for a headless backup', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({
        id: 'root',
        slug: 'alpha',
        author: 'a@socket.dev',
        body: 'top level',
      }),
    ]
    const res = await h.call(EXPORT_ROUTE, {
      params: { slug: 'alpha' },
      token: ADMIN_TOKEN,
    })
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })

  it('exports only the requested walkthrough', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'a1', slug: 'alpha', author: 'a@socket.dev' }),
      await makeRow({ id: 'b1', slug: 'beta', author: 'a@socket.dev' }),
    ]
    const res = await h.call(EXPORT_ROUTE, {
      params: { slug: 'alpha' },
      token: await sessionFor('a@socket.dev'),
    })
    expect(res.body).toHaveLength(1)
  })
})
