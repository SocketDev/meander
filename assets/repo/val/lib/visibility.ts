/**
 * Walkthrough visibility — the val's record of which slugs are
 * private, and the blob oracle that record is derived from.
 *
 * A walkthrough is private exactly when its stored HTML carries the
 * `ENVELOPE:` prefix. `lib/pages.ts` reads that straight off the blob
 * it already fetched to serve the page. The comment API cannot: a
 * comment read touches no blob, and a full blob GET on every poll of
 * `GET /:slug/api/comments?part=N` would buy one bit of information
 * for the price of an entire encrypted document.
 *
 * So the verdict is recorded in SQLite, beside the comments the gate
 * protects, and two writers keep it true:
 *
 * - `meander publish` writes it, because publishing is what makes a walkthrough
 *   private. It marks a slug private BEFORE uploading ciphertext and writes the
 *   settled value after the last upload, so the recorded flag is the more
 *   restrictive of the old and new states for the whole of a transition — there
 *   is no instant at which the blob is private and the record says otherwise.
 * - The val derives and persists the flag the first time it is asked about a slug
 *   it has no row for. That is what carries a deployment whose walkthroughs
 *   were published before this table existed.
 *
 * An unrecorded slug is never assumed public. `resolveSlugPrivacy`
 * derives before it answers, and a derivation it cannot complete —
 * absent blob, unreachable blob store — answers private. Guessing
 * public is the one failure the gate exists to prevent.
 */

import type { SqliteClient } from './admin.ts'
import { unpackEnvelope } from './crypto.ts'

/**
 * `slug` is the primary key, so the lookup the comment routes make
 * on every read is an index seek rather than a scan. `recorded_at`
 * is for operators reading the table by hand — nothing branches on
 * it, and in particular it is not a TTL: a row is authoritative
 * until a writer replaces it.
 */
export const WALKTHROUGH_VISIBILITY_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS walkthrough_visibility (
      slug         TEXT PRIMARY KEY,
      is_private   INTEGER NOT NULL,
      recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `

/**
 * Probe the blob store for whether `slug` should be treated as
 * private. Reads the walkthrough's index page, since `publish`
 * encrypts every page of a walkthrough or none of them.
 *
 * An absent blob answers private. It means the caller is asking
 * about a walkthrough this deployment cannot serve, and a slug with
 * no prose to check is not evidence of a public one.
 */
export type SlugPrivacyProbe = (slug: string) => Promise<boolean>

/**
 * Does this blob's text carry the envelope prefix? A blob that
 * carries the prefix but does not parse counts as encrypted: the val
 * cannot serve it either way, and guessing "public" on a malformed
 * private blob would be the wrong side to fail on.
 *
 * The single oracle for "is this walkthrough private" — `pages.ts`
 * and the comment gate both decide through it, so the page a reader
 * is refused and the discussion they are refused stay in agreement.
 */
export function blobTextIsEncrypted(text: string): boolean {
  try {
    return unpackEnvelope(text) !== undefined
  } catch {
    return true
  }
}

/**
 * Derive `slug`'s privacy from the blob store. See
 * `SlugPrivacyProbe` for why an absent blob answers private.
 */
export async function probeSlugPrivacy(
  readBlobText: (relativeKey: string) => Promise<string | undefined>,
  slug: string,
): Promise<boolean> {
  const text = await readBlobText(`${slug}/index.html`)
  if (text === undefined) {
    return true
  }
  return blobTextIsEncrypted(text)
}

/**
 * The recorded privacy of `slug`, or undefined when no writer has
 * recorded one. Undefined is the caller's cue to derive — it must
 * never be read as "public".
 */
export async function readRecordedSlugPrivacy(
  sqlite: SqliteClient,
  slug: string,
): Promise<boolean | undefined> {
  const result = await sqlite.execute({
    sql: 'SELECT is_private FROM walkthrough_visibility WHERE slug = :slug',
    args: { slug },
  })
  const row = result.rows[0] as { is_private: number } | undefined
  if (!row) {
    return undefined
  }
  return !!row.is_private
}

/**
 * Write `slug`'s privacy, replacing any earlier record. Idempotent,
 * so publish can call it twice around an upload and the val can call
 * it on a slug another request just recorded.
 */
export async function recordSlugPrivacy(
  sqlite: SqliteClient,
  visibility: { slug: string; isPrivate: boolean },
): Promise<void> {
  const record = { __proto__: null, ...visibility } as typeof visibility
  await sqlite.execute({
    sql: "INSERT INTO walkthrough_visibility (slug, is_private, recorded_at) VALUES (:slug, :isPrivate, datetime('now')) ON CONFLICT(slug) DO UPDATE SET is_private = excluded.is_private, recorded_at = excluded.recorded_at",
    args: { slug: record.slug, isPrivate: record.isPrivate ? 1 : 0 },
  })
}

/**
 * Is `slug` private? Answers from the recorded flag when there is
 * one — an index seek, no blob traffic — and otherwise derives it
 * from the blob store and persists the answer, so the derivation is
 * paid at most once per slug per deployment.
 *
 * A probe that throws answers private and records nothing, leaving
 * the next request free to derive again once the blob store
 * recovers.
 */
export async function resolveSlugPrivacy(
  sqlite: SqliteClient,
  slug: string,
  probe: SlugPrivacyProbe,
): Promise<boolean> {
  const recorded = await readRecordedSlugPrivacy(sqlite, slug)
  if (recorded !== undefined) {
    return recorded
  }
  let derived: boolean
  try {
    derived = await probe(slug)
  } catch {
    return true
  }
  await recordSlugPrivacy(sqlite, { slug, isPrivate: derived })
  return derived
}
