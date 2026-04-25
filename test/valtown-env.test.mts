/**
 * @fileoverview Tests for src/valtown-env.mts.
 *
 * The module is a thin REST client for Val Town's env-var API.
 * We stub `fetch` and assert (a) we send the right payload, and
 * (b) we handle the response shapes we actually see in
 * production: 404 for missing keys, mixed PUT-then-POST for
 * setEnvVar, JSON `{ data: [...] }` for list.
 *
 * No live network. No real Val Town account.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  deleteEnvVar,
  generateSecret,
  getEnvVar,
  listEnvVarNames,
  setEnvVar,
} from '../src/valtown-env.mts'

type FetchCall = {
  url: string
  method: string
  body: string | undefined
  authHeader: string | undefined
  contentType: string | undefined
}

let calls: FetchCall[] = []

function recordCall(input: RequestInfo | URL, init?: RequestInit): FetchCall {
  const url = typeof input === 'string' ? input : input.toString()
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers ?? {})
  return {
    url,
    method,
    body: typeof init?.body === 'string' ? init.body : undefined,
    authHeader: headers.get('authorization') ?? undefined,
    contentType: headers.get('content-type') ?? undefined,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getEnvVar', () => {
  it('returns the value when the key exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push(recordCall(input, init))
      return jsonResponse(200, { value: 'secret-value' })
    })
    const value = await getEnvVar('tok', 'val-id', 'MY_KEY')
    expect(value).toBe('secret-value')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toBe(
      'https://api.val.town/v2/vals/val-id/environment_variables/MY_KEY',
    )
    expect(calls[0]!.authHeader).toBe('Bearer tok')
  })

  it('returns undefined on 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('not found', { status: 404 })
    })
    const value = await getEnvVar('tok', 'val-id', 'MISSING')
    expect(value).toBeUndefined()
  })

  it('returns undefined when response body lacks a `value` field', async () => {
    /* Defensive: shape mismatch from the API shouldn't blow up
     * the ceremony — undefined is the safe interpretation. */
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return jsonResponse(200, { something_else: 'x' })
    })
    expect(await getEnvVar('tok', 'val-id', 'MY_KEY')).toBeUndefined()
  })

  it('throws on non-OK non-404 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('server boom', { status: 500 })
    })
    await expect(getEnvVar('tok', 'val-id', 'MY_KEY')).rejects.toThrow(
      /500/,
    )
  })
})

describe('setEnvVar', () => {
  it('PUTs first; succeeds when the key already exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push(recordCall(input, init))
      return new Response('', { status: 200 })
    })
    await setEnvVar('tok', 'val-id', 'MY_KEY', 'val')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('PUT')
    expect(calls[0]!.url).toBe(
      'https://api.val.town/v2/vals/val-id/environment_variables/MY_KEY',
    )
    expect(calls[0]!.body).toBe(JSON.stringify({ value: 'val' }))
    expect(calls[0]!.contentType).toBe('application/json')
    expect(calls[0]!.authHeader).toBe('Bearer tok')
  })

  it('falls back to POST when PUT fails (key does not yet exist)', async () => {
    let put = 0
    let post = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const call = recordCall(input, init)
      calls.push(call)
      if (call.method === 'PUT') {
        put++
        return new Response('not found', { status: 404 })
      }
      post++
      return new Response('', { status: 201 })
    })
    await setEnvVar('tok', 'val-id', 'NEW_KEY', 'val')
    expect(put).toBe(1)
    expect(post).toBe(1)
    /* The POST goes to the collection endpoint, not the keyed one. */
    expect(calls[1]!.url).toBe(
      'https://api.val.town/v2/vals/val-id/environment_variables',
    )
    expect(calls[1]!.body).toBe(JSON.stringify({ key: 'NEW_KEY', value: 'val' }))
  })

  it('throws when POST fallback also fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const call = recordCall(input, init)
      if (call.method === 'PUT') {
        return new Response('nope', { status: 404 })
      }
      return new Response('boom', { status: 500 })
    })
    await expect(
      setEnvVar('tok', 'val-id', 'KEY', 'val'),
    ).rejects.toThrow(/500/)
  })
})

describe('deleteEnvVar', () => {
  it('returns true when the key existed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push(recordCall(input, init))
      return new Response('', { status: 200 })
    })
    expect(await deleteEnvVar('tok', 'val-id', 'OLD')).toBe(true)
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.authHeader).toBe('Bearer tok')
  })

  it('returns false on 404 (was not there to begin with)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('', { status: 404 })
    })
    expect(await deleteEnvVar('tok', 'val-id', 'GONE')).toBe(false)
  })

  it('throws on non-OK non-404 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('boom', { status: 500 })
    })
    await expect(deleteEnvVar('tok', 'val-id', 'X')).rejects.toThrow(/500/)
  })
})

describe('listEnvVarNames', () => {
  it('returns the names from the API response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push(recordCall(input, init))
      return jsonResponse(200, {
        data: [
          { key: 'MEANDER_DB_KEY_1', value: '<hidden>' },
          { key: 'MEANDER_DB_KEY_CURRENT' },
          { key: 'MEANDER_OUT_DIR' },
        ],
      })
    })
    const names = await listEnvVarNames('tok', 'val-id')
    expect(names).toEqual([
      'MEANDER_DB_KEY_1',
      'MEANDER_DB_KEY_CURRENT',
      'MEANDER_OUT_DIR',
    ])
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toBe(
      'https://api.val.town/v2/vals/val-id/environment_variables',
    )
  })

  it('skips entries without a string `key` field', async () => {
    /* Shape variance from the API shouldn't crash the ceremony —
     * just drop the malformed entries. */
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return jsonResponse(200, {
        data: [
          { key: 'GOOD' },
          { value: 'no-key-field' },
          { key: 42 }, // wrong type
          {}, // empty
        ],
      })
    })
    expect(await listEnvVarNames('tok', 'val-id')).toEqual(['GOOD'])
  })

  it('returns empty when `data` is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return jsonResponse(200, {})
    })
    expect(await listEnvVarNames('tok', 'val-id')).toEqual([])
  })

  it('throws on non-OK status', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('boom', { status: 500 })
    })
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
