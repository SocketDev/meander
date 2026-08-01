/**
 * @file Tests for the val's session gate (assets/val/lib/auth.ts) and the
 *   admin-token predicate (assets/val/lib/admin.ts). Both modules are pure —
 *   no Deno globals, no `https://esm.town/...` imports — so Node drives them
 *   directly. `assets/val/index.ts` only binds the gate to env config.
 */

import { describe, expect, it } from 'vitest'

import { isAdminToken, readBearerToken } from '../assets/val/lib/admin.ts'
import { authGate } from '../assets/val/lib/auth.ts'

function contextWithHeader(
  value: string | undefined,
): Parameters<typeof isAdminToken>[0] {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? value : undefined,
    },
  } as unknown as Parameters<typeof isAdminToken>[0]
}

const OPEN = { allowedDomains: ['socket.dev'], demoMode: false }

describe('authGate', () => {
  it('allows an email on an allowed domain', () => {
    expect(authGate('reviewer@socket.dev', OPEN)).toBeUndefined()
  })

  it('matches the domain case-insensitively', () => {
    expect(authGate('Reviewer@Socket.DEV', OPEN)).toBeUndefined()
  })

  it('denies an absent identity with 401', () => {
    expect(authGate(undefined, OPEN)).toEqual({
      error: 'authentication required',
      status: 401,
    })
  })

  it('denies a domain outside the allowlist with 403', () => {
    expect(authGate('outsider@example.com', OPEN)).toEqual({
      error: 'email domain not allowed',
      status: 403,
    })
  })

  it('denies everyone when the allowlist is empty', () => {
    const denied = authGate('reviewer@socket.dev', {
      allowedDomains: [],
      demoMode: false,
    })
    expect(denied?.status).toBe(403)
    expect(denied?.error).toContain('MEANDER_ALLOWED_EMAIL_DOMAINS')
  })

  it('denies in demo mode regardless of the session', () => {
    expect(
      authGate('reviewer@socket.dev', {
        allowedDomains: ['socket.dev'],
        demoMode: true,
      }),
    ).toEqual({ error: 'demo mode — writes disabled', status: 403 })
  })

  it('names the operation in the denial message', () => {
    expect(
      authGate('reviewer@socket.dev', {
        allowedDomains: ['socket.dev'],
        demoMode: true,
        operation: 'export',
      }),
    ).toEqual({ error: 'demo mode — export disabled', status: 403 })
  })

  it('keeps the documented write message when no operation is named', () => {
    const denied = authGate(undefined, { allowedDomains: [], demoMode: true })
    expect(denied?.error).toBe('demo mode — writes disabled')
  })
})

describe('readBearerToken', () => {
  it('reads the token from a Bearer header', () => {
    expect(readBearerToken(contextWithHeader('Bearer abc123'))).toBe('abc123')
  })

  it('accepts the scheme case-insensitively', () => {
    expect(readBearerToken(contextWithHeader('bearer abc123'))).toBe('abc123')
  })

  it('returns undefined with no header', () => {
    expect(readBearerToken(contextWithHeader(undefined))).toBeUndefined()
  })

  it('returns undefined for a non-Bearer scheme', () => {
    expect(readBearerToken(contextWithHeader('Basic abc123'))).toBeUndefined()
  })
})

describe('isAdminToken', () => {
  it('accepts the configured admin token', () => {
    expect(isAdminToken(contextWithHeader('Bearer s3cret'), 's3cret')).toBe(
      true,
    )
  })

  it('rejects a different token', () => {
    expect(isAdminToken(contextWithHeader('Bearer wrong'), 's3cret')).toBe(
      false,
    )
  })

  it('rejects a prefix of the admin token', () => {
    expect(isAdminToken(contextWithHeader('Bearer s3c'), 's3cret')).toBe(false)
  })

  it('never matches when the val has no admin token configured', () => {
    expect(isAdminToken(contextWithHeader('Bearer '), '')).toBe(false)
    expect(isAdminToken(contextWithHeader(undefined), '')).toBe(false)
  })
})
