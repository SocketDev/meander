/**
 * @file Ownership + slug-scoping coverage for the val's comment mutations
 *   (PATCH / DELETE /:slug/api/comments/:id).
 *   Harness: test/utils/val-comment-harness.mts. The read routes and their
 *   reader gate live in test/val-comment-reads.test.mts.
 */

import { describe, expect, it } from 'vitest'

import {
  ADMIN_TOKEN,
  DELETE_ROUTE,
  makeHarness,
  makeRow,
  PATCH_ROUTE,
  sessionFor,
} from './utils/val-comment-harness.mts'

/* ------------------------------------------------------------------ */
/*  Resolve                                                             */
/* ------------------------------------------------------------------ */

describe('PATCH /:slug/api/comments/:id', () => {
  it('denies an anonymous caller with 401', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(PATCH_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      body: { resolved: true },
    })
    expect(res.status).toBe(401)
    expect(h.sqlite.rows[0]!.resolved).toBe(0)
  })

  it('lets the author resolve their own comment', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(PATCH_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: await sessionFor('a@socket.dev'),
      body: { resolved: true },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: 'c1', resolved: true })
    expect(h.sqlite.rows[0]!.resolved).toBe(1)
  })

  it('lets the admin token resolve any comment', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(PATCH_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: ADMIN_TOKEN,
      body: { resolved: true },
    })
    expect(res.status).toBe(200)
    expect(h.sqlite.rows[0]!.resolved).toBe(1)
  })

  it('refuses a signed-in user who did not author the comment', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(PATCH_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: await sessionFor('b@socket.dev'),
      body: { resolved: true },
    })
    expect(res.status).toBe(403)
    expect(h.sqlite.rows[0]!.resolved).toBe(0)
  })

  it('does not reach a comment in another walkthrough', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'beta', author: 'a@socket.dev' }),
    ]
    const res = await h.call(PATCH_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: await sessionFor('a@socket.dev'),
      body: { resolved: true },
    })
    expect(res.status).toBe(404)
    expect(h.sqlite.rows[0]!.resolved).toBe(0)
  })

  it('rejects a non-boolean resolved field', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(PATCH_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: await sessionFor('a@socket.dev'),
      body: { resolved: 'yes' },
    })
    expect(res.status).toBe(400)
  })
})

/* ------------------------------------------------------------------ */
/*  Delete                                                              */
/* ------------------------------------------------------------------ */

describe('DELETE /:slug/api/comments/:id', () => {
  it('denies an anonymous caller with 401', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(DELETE_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
    })
    expect(res.status).toBe(401)
    expect(h.sqlite.rows).toHaveLength(1)
  })

  it('lets the author delete their own comment', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(DELETE_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: await sessionFor('a@socket.dev'),
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: 'c1', deleted: 1 })
    expect(h.sqlite.rows).toHaveLength(0)
  })

  it('lets the admin token delete any comment', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(DELETE_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: ADMIN_TOKEN,
    })
    expect(res.status).toBe(200)
    expect(h.sqlite.rows).toHaveLength(0)
  })

  it("refuses to delete another user's comment", async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(DELETE_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: await sessionFor('b@socket.dev'),
    })
    expect(res.status).toBe(403)
    expect(h.sqlite.rows).toHaveLength(1)
  })

  it('does not reach a comment in another walkthrough', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'c1', slug: 'beta', author: 'a@socket.dev' }),
    ]
    const res = await h.call(DELETE_ROUTE, {
      params: { slug: 'alpha', id: 'c1' },
      token: await sessionFor('a@socket.dev'),
    })
    expect(res.status).toBe(404)
    expect(h.sqlite.rows).toHaveLength(1)
  })

  it('takes the replies with the root comment', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'root', slug: 'alpha', author: 'a@socket.dev' }),
      await makeRow({
        id: 'reply',
        slug: 'alpha',
        author: 'b@socket.dev',
        parentId: 'root',
      }),
      await makeRow({ id: 'other', slug: 'alpha', author: 'a@socket.dev' }),
    ]
    const res = await h.call(DELETE_ROUTE, {
      params: { slug: 'alpha', id: 'root' },
      token: await sessionFor('a@socket.dev'),
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: 'root', deleted: 2 })
    expect(h.sqlite.rows.map(row => row.id)).toEqual(['other'])
  })

  it('leaves the root standing when a reply is deleted', async () => {
    const h = await makeHarness()
    h.sqlite.rows = [
      await makeRow({ id: 'root', slug: 'alpha', author: 'a@socket.dev' }),
      await makeRow({
        id: 'reply',
        slug: 'alpha',
        author: 'b@socket.dev',
        parentId: 'root',
      }),
    ]
    const res = await h.call(DELETE_ROUTE, {
      params: { slug: 'alpha', id: 'reply' },
      token: await sessionFor('b@socket.dev'),
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: 'reply', deleted: 1 })
    expect(h.sqlite.rows.map(row => row.id)).toEqual(['root'])
  })
})
