/**
 * @file Pins the two copies of the `walkthrough_visibility` schema together.
 *   Both the val (assets/val/lib/visibility.ts, run from `ensureDb`) and
 *   `meander publish` (src/val-visibility.mts) bootstrap the table, because
 *   either can reach the database first. They cannot share the constant by
 *   import: the val tree is Deno source carrying `npm:` specifiers, and the
 *   Node build's `rootDir` is `src`. A test can import both, so this is where
 *   the two statements are held to being the same statement.
 *   Also covers the publisher-side write itself — the batch it sends, and the
 *   message shape a failed write reports. `nock` intercepts at the
 *   http/https layer, so no live network and no real Val Town account.
 */

import nock from 'nock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WALKTHROUGH_VISIBILITY_TABLE_SQL as VAL_TABLE_SQL } from '../assets/val/lib/visibility.ts'
// oxlint-disable-next-line socket/no-src-import-in-test-expect -- both constants ARE the system under test: the assertion is that the val's copy of the DDL and publish's copy are the same statement. Neither builds an expected value out of a helper, and the val-side constant has no published-snapshot alias to import instead.
import {
  API_BASE,
  recordPublishedVisibility,
  visibilityWriteFailure,
  WALKTHROUGH_VISIBILITY_TABLE_SQL as PUBLISH_TABLE_SQL,
} from '../src/val-visibility.mts'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('the walkthrough_visibility schema', () => {
  it('is the same statement on both sides', () => {
    expect(VAL_TABLE_SQL).toBe(PUBLISH_TABLE_SQL)
  })

  it('creates the table only when it is absent', () => {
    expect(VAL_TABLE_SQL).toContain(
      'CREATE TABLE IF NOT EXISTS walkthrough_visibility',
    )
  })
})

describe('visibilityWriteFailure', () => {
  it('names what failed, where, what it saw, and the fix', () => {
    const message = visibilityWriteFailure(
      { slug: 'alpha', isPrivate: true },
      'https://api.val.town/v1/sqlite/batch',
      'HTTP 403 forbidden',
    )
    expect(message).toContain('Failed to record walkthrough "alpha" as private')
    expect(message).toContain(
      'Where: POST https://api.val.town/v1/sqlite/batch',
    )
    expect(message).toContain('Saw: HTTP 403 forbidden; wanted a 2xx response.')
    expect(message).toContain('Fix:')
  })

  it('names the public state when that is what failed to land', () => {
    const message = visibilityWriteFailure(
      { slug: 'alpha', isPrivate: false },
      'https://api.val.town/v1/sqlite/batch',
      'HTTP 500 boom',
    )
    expect(message).toContain('as public')
  })
})

describe('recordPublishedVisibility', () => {
  it('creates the table and writes the row in one batch', async () => {
    let sent: {
      mode?: string | undefined
      statements?: unknown[] | undefined
    } = {}
    const scope = nock(API_BASE)
      .post('/v1/sqlite/batch', body => {
        sent = body as typeof sent
        return true
      })
      .matchHeader('authorization', 'Bearer tok')
      .reply(200, [])
    await recordPublishedVisibility('tok', { slug: 'alpha', isPrivate: true })
    expect(scope.isDone()).toBe(true)
    expect(sent.mode).toBe('write')
    expect(sent.statements?.[0]).toBe(VAL_TABLE_SQL)
    const upsert = sent.statements?.[1] as { sql: string; args: unknown[] }
    expect(upsert.sql).toContain('INSERT INTO walkthrough_visibility')
    expect(upsert.sql).toContain('ON CONFLICT(slug) DO UPDATE')
    expect(upsert.args).toEqual(['alpha', 1])
  })

  it('writes 0 for a walkthrough published in plaintext', async () => {
    let sent: { statements?: unknown[] | undefined } = {}
    nock(API_BASE)
      .post('/v1/sqlite/batch', body => {
        sent = body as typeof sent
        return true
      })
      .reply(200, [])
    await recordPublishedVisibility('tok', { slug: 'alpha', isPrivate: false })
    const upsert = sent.statements?.[1] as { args: unknown[] }
    expect(upsert.args).toEqual(['alpha', 0])
  })

  it('throws with the four-part message on a non-2xx response', async () => {
    nock(API_BASE).post('/v1/sqlite/batch').reply(403, 'forbidden')
    await expect(
      recordPublishedVisibility('tok', { slug: 'alpha', isPrivate: true }),
    ).rejects.toThrow(/Failed to record walkthrough "alpha" as private/)
  })

  it('reports the status it saw', async () => {
    nock(API_BASE).post('/v1/sqlite/batch').reply(500, 'boom')
    await expect(
      recordPublishedVisibility('tok', { slug: 'alpha', isPrivate: true }),
    ).rejects.toThrow(/Saw: HTTP 500/)
  })
})
