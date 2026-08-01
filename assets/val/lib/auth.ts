/**
 * Auth helpers — the session gate, email-domain allowlist, 6-digit
 * code gen, salted-hash for the magic_codes table. Pure; importable
 * by both the val (Deno) and Node tests.
 */

import { b64urlEncode } from './jwt.ts'

/**
 * Everything the gate decides on. `index.ts` fills it from the
 * val's env; tests pass literals.
 */
export type AuthGateConfig = {
  /**
   * Lowercased email domains permitted to act. Empty means nobody
   * is — the safe posture for a fresh deploy.
   */
  allowedDomains: readonly string[]
  demoMode: boolean
  /**
   * Names the action in the denial message. Default: 'writes'.
   */
  operation?: string | undefined
}

export type AuthGateOptions = {
  /**
   * Names the action in the denial message. Default: 'writes'.
   */
  operation?: string | undefined
}

/**
 * Decide whether a session identity may perform a gated action.
 * Comment writes and the comment export share this gate: both hand
 * the caller plaintext other people authored, so both want a
 * verified session on an allowed domain.
 *
 * Returns undefined when the caller may proceed. `email` must
 * already be a *verified* identity — the caller resolves it from a
 * signature-checked JWT, never from an unverified claim.
 */
export function authGate(
  email: string | undefined,
  config: AuthGateConfig,
): { error: string; status: 401 | 403 } | undefined {
  const cfg = { __proto__: null, ...config } as AuthGateConfig
  const operation = cfg.operation ?? 'writes'
  if (cfg.demoMode) {
    return { error: `demo mode — ${operation} disabled`, status: 403 }
  }
  return identityGate(email, cfg.allowedDomains, operation)
}

export function emailDomainAllowed(
  email: string,
  allowed: readonly string[],
): boolean {
  const at = email.indexOf('@')
  if (at < 0) {
    return false
  }
  const domain = email.slice(at + 1).toLowerCase()
  return allowed.includes(domain)
}

/**
 * Hash a magic code with the email as a salt. Stored server-side
 * in the `magic_codes` table; the raw code never lands on disk.
 */
export async function hashCode(code: string, email: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${email}:${code}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return b64urlEncode(new Uint8Array(digest))
}

/**
 * Decide whether a verified identity clears the deployment's
 * allowlist for `operation`. This is the half of the gate that
 * asks "who are you"; `authGate` layers the demo-mode refusal on
 * top for write paths.
 *
 * Reader gating calls this directly. Demo mode disables *writes* —
 * a demo deployment still serves its pages — so a reader must not
 * inherit the write path's demo refusal.
 */
export function identityGate(
  email: string | undefined,
  allowedDomains: readonly string[],
  operation: string,
): { error: string; status: 401 | 403 } | undefined {
  if (!email) {
    return { error: 'authentication required', status: 401 }
  }
  if (allowedDomains.length === 0) {
    return {
      error: `${operation} disabled — server has no MEANDER_ALLOWED_EMAIL_DOMAINS`,
      status: 403,
    }
  }
  if (!emailDomainAllowed(email, allowedDomains)) {
    return { error: 'email domain not allowed', status: 403 }
  }
  return undefined
}

export function parseAllowedDomains(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Random 6-digit numeric code, zero-padded. Uses
 * crypto.getRandomValues for unpredictability.
 */
export function sixDigitCode(): string {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return (buf[0] % 1_000_000).toString().padStart(6, '0')
}
