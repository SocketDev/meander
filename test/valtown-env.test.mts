/**
 * @file Tests for src/valtown-env.mts.
 *   The module is a thin REST client for Val Town's env-var API.
 *   Since @socketsecurity/lib 6.x, `httpRequest` drives requests
 *   through Node's `http`/`https` modules (not `fetch`), so we
 *   intercept at that layer with `nock` and assert (a) we send the
 *   right method + URL + auth + payload, and (b) we handle the
 *   response shapes we actually see in production: 404 for missing
 *   keys, mixed PUT-then-POST for setEnvVar, JSON `{ data: [...] }`
 *   for list.
 *   No live network. No real Val Town account.
 */

import nock from 'nock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  API_BASE,
  deleteEnvVar,
  generateSecret,
  getEnvVar,
  listEnvVarNames,
  setEnvVar,
} from '../src/valtown-env.mts'

beforeEach(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
  nock.enableNetConnect()
})

describe('getEnvVar', () => {
  it('returns the value when the key exists', async () => {
    const scope = nock(API_BASE)
      .get('/v2/vals/val-id/environment_variables/MY_KEY')
      .matchHeader('authorization', 'Bearer tok')
      .reply(200, { value: 'secret-value' })
    const value = await getEnvVar('tok', 'val-id', 'MY_KEY')
    expect(value).toBe('secret-value')
    expect(scope.isDone()).toBe(true)
  })

  it('returns undefined on 404', async () => {
    nock(API_BASE)
      .get('/v2/vals/val-id/environment_variables/MISSING')
      .reply(404, 'not found')
    const value = await getEnvVar('tok', 'val-id', 'MISSING')
    expect(value).toBeUndefined()
  })

  it('returns undefined when response body lacks a `value` field', async () => {
    /* Defensive: shape mismatch from the API shouldn't blow up
     * the ceremony — undefined is the safe interpretation. */
    nock(API_BASE)
      .get('/v2/vals/val-id/environment_variables/MY_KEY')
      .reply(200, { something_else: 'x' })
    expect(await getEnvVar('tok', 'val-id', 'MY_KEY')).toBeUndefined()
  })

  it('throws on non-OK non-404 status', async () => {
    nock(API_BASE)
      .get('/v2/vals/val-id/environment_variables/MY_KEY')
      .reply(500, 'server boom')
    await expect(getEnvVar('tok', 'val-id', 'MY_KEY')).rejects.toThrow(/500/)
  })
})

describe('setEnvVar', () => {
  it('PUTs first; succeeds when the key already exists', async () => {
    const scope = nock(API_BASE)
      .put('/v2/vals/val-id/environment_variables/MY_KEY', { value: 'val' })
      .matchHeader('authorization', 'Bearer tok')
      .matchHeader('content-type', 'application/json')
      .reply(200, '')
    await setEnvVar('tok', 'val-id', 'MY_KEY', 'val')
    /* isDone() is true only if the single PUT — with the matched
     * method, URL, auth, content-type, and body — actually fired. */
    expect(scope.isDone()).toBe(true)
  })

  it('falls back to POST when PUT fails (key does not yet exist)', async () => {
    /* The POST goes to the collection endpoint, not the keyed one,
     * and carries `{ key, value }`. */
    const scope = nock(API_BASE)
      .put('/v2/vals/val-id/environment_variables/NEW_KEY', { value: 'val' })
      .reply(404, 'not found')
      .post('/v2/vals/val-id/environment_variables', {
        key: 'NEW_KEY',
        value: 'val',
      })
      .reply(201, '')
    await setEnvVar('tok', 'val-id', 'NEW_KEY', 'val')
    expect(scope.isDone()).toBe(true)
  })

  it('throws when POST fallback also fails', async () => {
    nock(API_BASE)
      .put('/v2/vals/val-id/environment_variables/KEY')
      .reply(404, 'nope')
      .post('/v2/vals/val-id/environment_variables')
      .reply(500, 'boom')
    await expect(setEnvVar('tok', 'val-id', 'KEY', 'val')).rejects.toThrow(
      /500/,
    )
  })
})

describe('deleteEnvVar', () => {
  it('returns true when the key existed', async () => {
    const scope = nock(API_BASE)
      .delete('/v2/vals/val-id/environment_variables/OLD')
      .matchHeader('authorization', 'Bearer tok')
      .reply(200, '')
    expect(await deleteEnvVar('tok', 'val-id', 'OLD')).toBe(true)
    expect(scope.isDone()).toBe(true)
  })

  it('returns false on 404 (was not there to begin with)', async () => {
    nock(API_BASE)
      .delete('/v2/vals/val-id/environment_variables/GONE')
      .reply(404, '')
    expect(await deleteEnvVar('tok', 'val-id', 'GONE')).toBe(false)
  })

  it('throws on non-OK non-404 status', async () => {
    nock(API_BASE)
      .delete('/v2/vals/val-id/environment_variables/X')
      .reply(500, 'boom')
    await expect(deleteEnvVar('tok', 'val-id', 'X')).rejects.toThrow(/500/)
  })
})

describe('listEnvVarNames', () => {
  it('returns the names from the API response', async () => {
    const scope = nock(API_BASE)
      .get('/v2/vals/val-id/environment_variables')
      .reply(200, {
        data: [
          { key: 'MEANDER_DB_KEY_1', value: '<hidden>' },
          { key: 'MEANDER_DB_KEY_CURRENT' },
          { key: 'MEANDER_OUT_DIR' },
        ],
      })
    const names = await listEnvVarNames('tok', 'val-id')
    expect(names).toEqual([
      'MEANDER_DB_KEY_1',
      'MEANDER_DB_KEY_CURRENT',
      'MEANDER_OUT_DIR',
    ])
    expect(scope.isDone()).toBe(true)
  })

  it('skips entries without a string `key` field', async () => {
    /* Shape variance from the API shouldn't crash the ceremony —
     * just drop the malformed entries. */
    nock(API_BASE)
      .get('/v2/vals/val-id/environment_variables')
      .reply(200, {
        data: [
          { key: 'GOOD' },
          { value: 'no-key-field' },
          { key: 42 }, // wrong type
          {}, // empty
        ],
      })
    expect(await listEnvVarNames('tok', 'val-id')).toEqual(['GOOD'])
  })

  it('returns empty when `data` is missing', async () => {
    nock(API_BASE).get('/v2/vals/val-id/environment_variables').reply(200, {})
    expect(await listEnvVarNames('tok', 'val-id')).toEqual([])
  })

  it('throws on non-OK status', async () => {
    nock(API_BASE)
      .get('/v2/vals/val-id/environment_variables')
      .reply(500, 'boom')
    await expect(listEnvVarNames('tok', 'val-id')).rejects.toThrow(/500/)
  })
})

describe('generateSecret', () => {
  it('produces base64url output of the requested entropy', () => {
    const s = generateSecret(32)
    /* base64url of 32 bytes is 43 chars (no padding). */
    expect(s.length).toBe(43)
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('produces distinct values per call', () => {
    const a = generateSecret(32)
    const b = generateSecret(32)
    expect(a).not.toBe(b)
  })

  it('honors a custom byte count', () => {
    const s = generateSecret(48)
    /* base64url of 48 bytes = 64 chars. */
    expect(s.length).toBe(64)
  })
})
