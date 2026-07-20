/**
 * Comments API route handlers for the val.
 *
 * Split out of `assets/val/index.ts` so the file stays under the
 * fleet's file-size cap and so the comment routes read as one
 * cohesive unit. Mirrors `lib/admin.ts`: the handlers receive their
 * dependencies (sqlite client, session helpers, wrapping-key
 * context) via a `Deps` struct passed when registering routes —
 * `index.ts` builds that struct at module load from Deno.env + the
 * val-town imports.
 *
 * Endpoints (all under `/:slug/api/comments`):
 * GET    /unresolved   Unresolved top-level comments for a slug.
 * GET    /             Comments for a slug + part.
 * POST   /             Create a comment (auth required).
 * PATCH  /:id          Toggle resolved (auth required).
 * DELETE /:id          Delete a comment (auth required).
 * GET    /export       Export comments as ticketing-friendly JSON.
 *
 * At-rest encryption is envelope-based: a random per-row DEK
 * encrypts body + author, and the DEK is wrapped under the current
 * generation's wrapping key (see docs/encryption.md).
 */

import type { Context, Hono } from 'npm:hono@4'

import type { SqliteClient } from './admin.ts'
import {
  decrypt,
  encrypt,
  importKey,
  randomDataKeyBytes,
  unwrapKey,
  wrapKey,
} from './crypto.ts'
import type { WrappingKeyContext } from './keys.ts'
import type {
  ApiComment,
  BaseComment,
  ExportedComment,
  ExportedComments,
} from '../types.ts'

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

export type CommentDeps = {
  sqlite: SqliteClient
  ensureDb: () => Promise<void>
  /**
   * Resolve the authenticated email from the request, or undefined.
   */
  currentUser: (c: Context) => Promise<string | undefined>
  /**
   * Gate a write: returns an error + status when the caller may not
   * write, or undefined when the write is allowed.
   */
  authRequired: (
    email: string | undefined,
  ) => { error: string; status: 401 | 403 } | undefined
  /**
   * May be undefined when the val booted without a configured
   * wrapping key — comment routes surface a 500 in that case.
   */
  keyContext: WrappingKeyContext | undefined
  /**
   * Reason the keyContext is missing. Surfaced verbatim in the
   * error body to help operators debug.
   */
  keyContextError: string | undefined
}

export async function decryptRows(
  rows: readonly unknown[],
  ctx: WrappingKeyContext,
): Promise<ApiComment[]> {
  /* Per-row: unwrap the DEK with that row's generation key, then
   * decrypt body + author. Multiple rows may share a generation, so
   * the imported CryptoKey for each generation is cached in `ctx`. */
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

/**
 * Register the comment routes on the Hono app. Returns the same app
 * for chainability — matches Hono's idiom (and `registerAdminRoutes`).
 */
export function registerCommentRoutes(app: Hono, deps: CommentDeps): Hono {
  app.get('/:slug/api/comments/unresolved', async c => {
    await deps.ensureDb()
    const slug = c.req.param('slug')
    if (!deps.keyContext) {
      return c.json(
        { error: serverMissingDbKeyMessage(deps.keyContextError) },
        500,
      )
    }
    const result = await deps.sqlite.execute({
      sql: 'SELECT id, slug, part, file, line_from, line_to, author, body, dek_wrapped, key_generation, parent_id, resolved, created_at FROM comments WHERE slug = :slug AND resolved = 0 AND parent_id IS NULL ORDER BY part ASC, created_at ASC',
      args: { slug },
    })
    return c.json(await decryptRows(result.rows, deps.keyContext))
  })

  app.get('/:slug/api/comments', async c => {
    await deps.ensureDb()
    const slug = c.req.param('slug')
    const part = c.req.query('part')
    if (!part) {
      return c.json({ error: 'part query parameter required' }, 400)
    }
    if (!deps.keyContext) {
      return c.json(
        { error: serverMissingDbKeyMessage(deps.keyContextError) },
        500,
      )
    }
    const result = await deps.sqlite.execute({
      sql: 'SELECT id, slug, part, file, line_from, line_to, author, body, dek_wrapped, key_generation, parent_id, resolved, created_at FROM comments WHERE slug = :slug AND part = :part ORDER BY created_at ASC',
      args: { slug, part: parseInt(part, 10) },
    })
    return c.json(await decryptRows(result.rows, deps.keyContext))
  })

  app.post('/:slug/api/comments', async c => {
    await deps.ensureDb()
    const email = await deps.currentUser(c)
    const deny = deps.authRequired(email)
    if (deny) {
      return c.json({ error: deny.error }, deny.status)
    }
    if (!deps.keyContext) {
      return c.json(
        { error: serverMissingDbKeyMessage(deps.keyContextError) },
        500,
      )
    }

    const slug = c.req.param('slug')
    const body = await c.req.json()
    const { part, file, lineFrom, lineTo, body: commentBody, parentId } = body
    const partInt = parseInt(part, 10)
    const lineFromInt = parseInt(lineFrom, 10)
    if (
      part == null ||
      isNaN(partInt) ||
      !file ||
      typeof file !== 'string' ||
      lineFrom == null ||
      isNaN(lineFromInt) ||
      !commentBody ||
      typeof commentBody !== 'string'
    ) {
      return c.json({ error: 'missing or invalid required fields' }, 400)
    }
    const lineToInt = lineTo != null ? parseInt(lineTo, 10) : lineFromInt
    if (isNaN(lineToInt)) {
      return c.json({ error: 'invalid lineTo value' }, 400)
    }

    /* Envelope encryption: random per-row DEK, body + author both
     * encrypted under the DEK, DEK wrapped under the current
     * generation's wrapping key. The wrapped DEK + generation are
     * stored on the row so a future read knows which key to use. */
    const dekBytes = randomDataKeyBytes()
    const dekImported = await importKey(dekBytes)
    const wrappingKey = await deps.keyContext.getCurrentKey()
    const encryptedAuthor = await encrypt(email!, dekImported)
    const encryptedBody = await encrypt(commentBody, dekImported)
    const dekWrapped = await wrapKey(dekBytes, wrappingKey)

    const id = crypto.randomUUID()
    await deps.sqlite.execute({
      sql: 'INSERT INTO comments (id, slug, part, file, line_from, line_to, author, body, dek_wrapped, key_generation, parent_id) VALUES (:id, :slug, :part, :file, :lineFrom, :lineTo, :author, :body, :dekWrapped, :keyGeneration, :parentId)',
      args: {
        id,
        slug,
        part: partInt,
        file,
        lineFrom: lineFromInt,
        lineTo: lineToInt,
        author: encryptedAuthor,
        body: encryptedBody,
        dekWrapped,
        keyGeneration: deps.keyContext.currentGeneration,
        // oxlint-disable-next-line socket/prefer-undefined-over-null -- libsql bind arg: null persists SQL NULL for a root comment; undefined would omit the named parameter.
        parentId: parentId || null,
      },
    })
    return c.json(
      {
        id,
        slug,
        part: partInt,
        file,
        lineFrom: lineFromInt,
        lineTo: lineToInt,
        author: email,
        body: commentBody,
        parentId: parentId || undefined,
        resolved: false,
        createdAt: new Date().toISOString(),
      },
      201,
    )
  })

  app.patch('/:slug/api/comments/:id', async c => {
    await deps.ensureDb()
    const email = await deps.currentUser(c)
    const deny = deps.authRequired(email)
    if (deny) {
      return c.json({ error: deny.error }, deny.status)
    }
    const id = c.req.param('id')
    const body = await c.req.json()
    const { resolved } = body
    if (typeof resolved !== 'boolean') {
      return c.json({ error: 'resolved field (boolean) required' }, 400)
    }
    await deps.sqlite.execute({
      sql: 'UPDATE comments SET resolved = :resolved WHERE id = :id',
      args: { id, resolved: resolved ? 1 : 0 },
    })
    return c.json({ ok: true, id, resolved })
  })

  app.delete('/:slug/api/comments/:id', async c => {
    await deps.ensureDb()
    const email = await deps.currentUser(c)
    const deny = deps.authRequired(email)
    if (deny) {
      return c.json({ error: deny.error }, deny.status)
    }
    const id = c.req.param('id')
    await deps.sqlite.execute({
      sql: 'DELETE FROM comments WHERE id = :id',
      args: { id },
    })
    return c.json({ ok: true })
  })

  app.get('/:slug/api/comments/export', async c => {
    await deps.ensureDb()
    const slug = c.req.param('slug')
    const unresolvedOnly = c.req.query('unresolved') === 'true'
    if (!deps.keyContext) {
      return c.json(
        { error: serverMissingDbKeyMessage(deps.keyContextError) },
        500,
      )
    }

    let sql =
      'SELECT id, slug, part, file, line_from, line_to, author, body, dek_wrapped, key_generation, parent_id, resolved, created_at FROM comments WHERE slug = :slug'
    if (unresolvedOnly) {
      sql += ' AND resolved = 0'
    }
    sql += ' ORDER BY part ASC, file ASC, line_from ASC, created_at ASC'
    const result = await deps.sqlite.execute({ sql, args: { slug } })
    const comments = await decryptRows(result.rows, deps.keyContext)

    const repliesByParentId = new Map<string, ApiComment[]>()
    for (const comment of comments) {
      if (comment.parentId) {
        const siblings = repliesByParentId.get(comment.parentId) || []
        siblings.push(comment)
        repliesByParentId.set(comment.parentId, siblings)
      }
    }
    const rootComments = comments.filter(x => !x.parentId)
    const exportedComments: ExportedComments = rootComments.map(
      (root): ExportedComment => {
        const replies = repliesByParentId.get(root.id) || []
        const children: BaseComment[] = replies.map(reply => ({
          author: reply.author,
          datetime: new Date(reply.createdAt).getTime(),
          content: reply.body,
        }))
        return {
          author: root.author,
          datetime: new Date(root.createdAt).getTime(),
          content: root.body,
          children,
          sourceFile: root.file,
          startLine: root.lineFrom,
          endLine: root.lineTo,
        }
      },
    )

    c.header('Content-Type', 'application/json; charset=utf-8')
    c.header(
      'Content-Disposition',
      `attachment; filename="${slug}-comments.json"`,
    )
    return c.json(exportedComments)
  })

  return app
}

export function serverMissingDbKeyMessage(
  keyContextError: string | undefined,
): string {
  if (keyContextError) {
    return keyContextError
  }
  return 'server missing MEANDER_DB_KEY_<n> + MEANDER_DB_KEY_CURRENT — run `meander db key init`'
}
