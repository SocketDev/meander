/**
 * Auth helpers — email-domain allowlist, 6-digit code gen,
 * salted-hash for the magic_codes table. Pure; importable by
 * both the val (Deno) and Node tests.
 */

import { b64urlEncode } from './jwt.ts'

export function parseAllowedDomains(raw: string | undefined | null): string[] {
  return (raw || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
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
 * Random 6-digit numeric code, zero-padded. Uses
 * crypto.getRandomValues for unpredictability.
 */
export function sixDigitCode(): string {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return (buf[0]! % 1_000_000).toString().padStart(6, '0')
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
