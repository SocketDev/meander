/**
 * Magic-code storage for the val's email sign-in.
 *
 * The `magic_codes` table holds a salted SHA-256 of the code, never
 * the code itself, plus an expiry and an attempt counter. Two
 * routes consume it: `POST /api/auth/verify`, which trades a code
 * for a comment-API session token, and
 * `POST /:slug/api/auth/session`, which trades the same code for an
 * encrypted walkthrough's reader cookie. Both call
 * `consumeMagicCode`, so the one-shot delete, the ten-minute
 * expiry, and the five-attempt ceiling hold identically on each.
 *
 * Sending the code is not here: it needs val-town's `std/email`,
 * and keeping this module free of `https://esm.town/...` imports is
 * what lets Node tests drive it.
 */

import type { SqliteClient } from './admin.ts'
import { hashCode } from './auth.ts'

export type MagicCodeOutcome =
  | { ok: true }
  | { ok: false; error: string; status: 400 | 401 | 429 }

/**
 * How long a freshly-issued code stays usable.
 */
export const MAGIC_CODE_TTL_SECONDS = 10 * 60

/**
 * Wrong guesses tolerated before the code is dead and the caller
 * must request a new one.
 */
export const MAGIC_CODE_MAX_ATTEMPTS = 5

export type MagicCodeRow = {
  code_hash: string
  expires_at: number
  attempts: number
}

/**
 * Check a presented code against the stored hash and burn it on
 * success. A wrong guess increments the attempt counter rather
 * than deleting the row, so a typo does not cost the reader a new
 * email round trip.
 */
export async function consumeMagicCode(
  sqlite: SqliteClient,
  email: string,
  code: string,
): Promise<MagicCodeOutcome> {
  const row = (
    await sqlite.execute({
      sql: 'SELECT code_hash, expires_at, attempts FROM magic_codes WHERE email = :email',
      args: { email },
    })
  ).rows[0] as MagicCodeRow | undefined
  if (!row) {
    return { ok: false, error: 'no code for this email', status: 400 }
  }
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: 'code expired', status: 400 }
  }
  if (row.attempts >= MAGIC_CODE_MAX_ATTEMPTS) {
    return {
      ok: false,
      error: 'too many attempts; request a new code',
      status: 429,
    }
  }
  const presentedHash = await hashCode(code, email)
  if (presentedHash !== row.code_hash) {
    await sqlite.execute({
      sql: 'UPDATE magic_codes SET attempts = attempts + 1 WHERE email = :email',
      args: { email },
    })
    return { ok: false, error: 'invalid code', status: 401 }
  }
  await sqlite.execute({
    sql: 'DELETE FROM magic_codes WHERE email = :email',
    args: { email },
  })
  return { ok: true }
}

/**
 * Store (or replace) the pending code for an email, resetting the
 * attempt counter. Requesting a fresh code is the documented way
 * out of a lockout.
 */
export async function storeMagicCode(
  sqlite: SqliteClient,
  email: string,
  codeHash: string,
  expiresAt: number,
): Promise<void> {
  await sqlite.execute({
    sql: `
      INSERT INTO magic_codes (email, code_hash, expires_at, attempts)
      VALUES (:email, :codeHash, :expiresAt, 0)
      ON CONFLICT(email) DO UPDATE SET
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0
    `,
    args: { email, codeHash, expiresAt },
  })
}
