/**
 * Records a walkthrough's privacy in the val's SQLite, from the
 * publisher's side.
 *
 * The val gates a private walkthrough's comment reads on a
 * `walkthrough_visibility` row rather than on a blob probe, so that a
 * comment poll costs an indexed row read. Something has to write that
 * row, and `meander publish` is the only thing in the system that
 * decides whether a walkthrough is private: it is what uploads
 * ciphertext or plaintext.
 *
 * Val Town vals share one SQLite database per account, and the token
 * publish already holds for the blob API reaches it. So the write
 * needs no val id, no val URL, and no second credential.
 *
 * `assets/val/lib/visibility.ts` carries the identical
 * `CREATE TABLE IF NOT EXISTS`. Both processes bootstrap the table
 * because either can be first: publish may run against a val that has
 * never served a request, and the val may boot against a database no
 * publish has touched. `test/val-visibility-schema.test.mts` asserts
 * the two statements stay byte-identical.
 */

import { errorMessage } from '@socketsecurity/lib/errors/message'
import { httpRequest } from '@socketsecurity/lib-stable/http-request'

export const API_BASE = 'https://api.val.town'

/**
 * Byte-identical to `WALKTHROUGH_VISIBILITY_TABLE_SQL` in
 * `assets/val/lib/visibility.ts`, which the val runs from `ensureDb`.
 * The val tree is Deno source the Node build cannot import, so the
 * statement is stated in both places and pinned by a test.
 */
export const WALKTHROUGH_VISIBILITY_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS walkthrough_visibility (
      slug         TEXT PRIMARY KEY,
      is_private   INTEGER NOT NULL,
      recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `

const UPSERT_VISIBILITY_SQL =
  "INSERT INTO walkthrough_visibility (slug, is_private, recorded_at) VALUES (?, ?, datetime('now')) ON CONFLICT(slug) DO UPDATE SET is_private = excluded.is_private, recorded_at = excluded.recorded_at"

export type WalkthroughVisibility = {
  slug: string
  isPrivate: boolean
}

/**
 * Record `slug`'s privacy so the val's comment routes can gate on it.
 *
 * Creates the table and writes the row in one batch, so a val that
 * has never booted still ends up with a usable record.
 *
 * Throws on any non-2xx response. A silent failure here would leave
 * the val gating on a stale flag while publish reported success,
 * which is the exact drift this record exists to remove.
 */
export async function recordPublishedVisibility(
  token: string,
  visibility: WalkthroughVisibility,
): Promise<void> {
  const record = { __proto__: null, ...visibility } as WalkthroughVisibility
  const url = `${API_BASE}/v1/sqlite/batch`
  let res
  try {
    res = await httpRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'write',
        statements: [
          WALKTHROUGH_VISIBILITY_TABLE_SQL,
          {
            sql: UPSERT_VISIBILITY_SQL,
            args: [record.slug, record.isPrivate ? 1 : 0],
          },
        ],
      }),
    })
  } catch (e) {
    throw new Error(
      visibilityWriteFailure(record, url, `request failed: ${errorMessage(e)}`),
    )
  }
  if (!res.ok) {
    throw new Error(
      visibilityWriteFailure(record, url, `HTTP ${res.status} ${res.text()}`),
    )
  }
}

/**
 * The four-part failure message for a visibility write: what failed,
 * where, what came back versus what was wanted, and what to do.
 */
export function visibilityWriteFailure(
  visibility: WalkthroughVisibility,
  url: string,
  saw: string,
): string {
  const record = { __proto__: null, ...visibility } as WalkthroughVisibility
  const state = record.isPrivate ? 'private' : 'public'
  return [
    `Failed to record walkthrough "${record.slug}" as ${state} in the val's SQLite.`,
    `Where: POST ${url} (walkthrough_visibility).`,
    `Saw: ${saw}; wanted a 2xx response.`,
    'Fix: check that the Val Town token has SQLite write access, then re-run `meander publish`.' +
      ' Until the record lands the val treats this walkthrough as private and refuses anonymous comment reads.',
  ].join(' ')
}
