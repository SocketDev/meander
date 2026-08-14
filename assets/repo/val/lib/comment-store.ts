/**
 * Comment storage layer for the val — the SQL shapes and the
 * envelope decrypt that `lib/comments.ts`'s route handlers sit on
 * top of.
 *
 * Split from the routes so the file that decides *authorization*
 * stays readable, and so every read goes through one column list
 * and one slug-scoped WHERE clause. A route never writes its own
 * `SELECT ... FROM comments`.
 *
 * At-rest encryption is envelope-based: a random per-row DEK
 * encrypts body + author, and the DEK is wrapped under some
 * generation's wrapping key (see docs/encryption.md).
 */

import type { SqliteClient } from './admin.ts'
import { decrypt, importKey, unwrapKey } from './crypto.ts'
import type { WrappingKeyContext } from './keys.ts'
import type { ApiComment } from '../types.ts'

/**
 * Raw comment row as stored in SQLite (snake_case columns), including
 * the envelope fields (`dek_wrapped`, `key_generation`) that the
 * public `ApiComment` shape omits.
 */
export interface EncryptedCommentRow {
  id: string
  slug: string
  part: number
  file: string
  line_from: number
  line_to: number
  author: string
  body: string
  dek_wrapped: string
  key_generation: number
  parent_id: string | null
  resolved: number
  created_at: string
}

/**
 * Every column a read needs, including the envelope fields. Shared
 * so a new read path can't accidentally omit `dek_wrapped` /
 * `key_generation` and fail to decrypt.
 */
export const COMMENT_COLUMNS_SQL =
  'SELECT id, slug, part, file, line_from, line_to, author, body, dek_wrapped, key_generation, parent_id, resolved, created_at FROM comments'

/**
 * Decrypt just the `author` column of one row. The ownership check
 * on PATCH/DELETE needs the author and nothing else, so this skips
 * the body decrypt that `decryptRows` does.
 */
export async function decryptRowAuthor(
  row: EncryptedCommentRow,
  ctx: WrappingKeyContext,
): Promise<string> {
  const wrapping = await ctx.getKey(row.key_generation)
  const dekBytes = await unwrapKey(row.dek_wrapped, wrapping)
  const dek = await importKey(dekBytes)
  return decrypt(row.author, dek)
}

export async function decryptRows(
  rows: readonly unknown[],
  ctx: WrappingKeyContext,
): Promise<ApiComment[]> {
  /* Per-row: unwrap the DEK with that row's generation key, then
   * decrypt body + author. Multiple rows may share a generation, so
   * the imported CryptoKey for each generation is cached in `ctx`.
   */
  return Promise.all(
    rows.map(async raw => {
      const row = raw as EncryptedCommentRow
      const gen = row.key_generation
      const wrapping = await ctx.getKey(gen)
      const dekBytes = await unwrapKey(row.dek_wrapped, wrapping)
      const dek = await importKey(dekBytes)
      return {
        id: row.id,
        slug: row.slug,
        part: row.part,
        file: row.file,
        lineFrom: row.line_from,
        lineTo: row.line_to,
        author: await decrypt(row.author, dek),
        body: await decrypt(row.body, dek),
        // oxlint-disable-next-line socket/prefer-undefined-over-null -- JSON sentinel: root comments serialize `parentId` as `null` (ApiComment.parentId is `string | null`); undefined would drop the key from the response.
        parentId: row.parent_id || null,
        resolved: !!row.resolved,
        createdAt: row.created_at,
      }
    }),
  )
}

export function notAuthorMessage(verb: string): string {
  return `only the comment's author or the val admin may ${verb} it — you are signed in as a different user; ask the author, or use MEANDER_ADMIN_TOKEN`
}

export function notFoundMessage(id: string, slug: string): string {
  return `comment ${id} not found in walkthrough "${slug}" — comment ids are scoped to one walkthrough; check the slug in the request path`
}

/**
 * One comment row, scoped to its walkthrough. A row whose `slug`
 * differs is not visible here, so an id borrowed from another
 * walkthrough reads as absent.
 */
export async function selectComment(
  sqlite: SqliteClient,
  slug: string,
  id: string,
): Promise<EncryptedCommentRow | undefined> {
  const result = await sqlite.execute({
    sql: `${COMMENT_COLUMNS_SQL} WHERE slug = :slug AND id = :id`,
    args: { slug, id },
  })
  return result.rows[0] as EncryptedCommentRow | undefined
}

/**
 * The comment `:id` plus every direct reply to it, scoped to
 * `:slug`. Replies are one level deep: the client only ever posts a
 * `parentId` of a root comment, so this is the full delete set for
 * that comment.
 */
export async function selectCommentWithReplies(
  sqlite: SqliteClient,
  slug: string,
  id: string,
): Promise<EncryptedCommentRow[]> {
  const result = await sqlite.execute({
    sql: `${COMMENT_COLUMNS_SQL} WHERE slug = :slug AND (id = :id OR parent_id = :id)`,
    args: { slug, id },
  })
  return result.rows as EncryptedCommentRow[]
}

export function serverMissingDbKeyMessage(
  keyContextError: string | undefined,
): string {
  if (keyContextError) {
    return keyContextError
  }
  return 'server missing MEANDER_DB_KEY_<n> + MEANDER_DB_KEY_CURRENT — run `meander db key init`'
}
