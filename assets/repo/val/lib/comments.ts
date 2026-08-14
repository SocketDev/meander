/**
 * Comments API route handlers for the val.
 *
 * Split out of `assets/val/index.ts` so the file stays under the
 * fleet's file-size cap and so the comment routes read as one
 * cohesive unit. Mirrors `lib/admin.ts`: the handlers receive their
 * dependencies (sqlite client, session helpers, wrapping-key
 * context) via a `Deps` struct passed when registering routes —
 * `index.ts` builds that struct at module load from Deno.env + the
 * val-town imports. The SQL shapes and the envelope decrypt live in
 * `lib/comment-store.ts`; this file owns routing and authorization.
 *
 * Endpoints (all under `/:slug/api/comments`):
 * GET    /unresolved   Unresolved top-level comments for a slug
 * (reader gate).
 * GET    /             Comments for a slug + part (reader gate).
 * POST   /             Create a comment (auth required).
 * PATCH  /:id          Toggle resolved (author or admin).
 * DELETE /:id          Delete a comment + its replies (author or admin).
 * GET    /export       Export comments as ticketing-friendly JSON
 * (auth required — it returns every author
 * identity and body in plaintext).
 *
 * Two identities can satisfy a gated route: a user session (the
 * JWT the magic-code flow mints, resolved by `deps.currentUser`)
 * or the val's `MEANDER_ADMIN_TOKEN`. The admin token is how a
 * headless backup job reaches `/export`, since the magic-code
 * flow needs a human mailbox.
 *
 * The two read routes carry the *reader* gate instead, the same one
 * `lib/pages.ts` puts on the prose: a private walkthrough's comments
 * open to the slug's reader cookie, a session bearer, or the admin
 * token, and a public walkthrough's comments stay open to everyone
 * with no sign-in. Reading a comment thread means reading decrypted
 * bodies and author identities, so gating the prose without gating
 * the discussion of it would leave the walkthrough private in name
 * only. Which walkthroughs are private is `lib/visibility.ts`'s
 * recorded flag, not a per-request blob probe.
 *
 * The export keeps its stronger gate. It hands back every body and
 * author for a slug at once, which is worth a session even when the
 * walkthrough is public.
 *
 * Writes are gated on the session alone. An author with a valid
 * session may comment on a private walkthrough whether or not their
 * browser also holds that slug's reader cookie.
 *
 * Every route scopes its SQL by `:slug`. One val hosts many
 * walkthroughs, so an id alone is not an authorization decision —
 * a comment id from walkthrough A must not resolve against
 * walkthrough B.
 *
 * At-rest encryption is envelope-based: a random per-row DEK
 * encrypts body + author, and the DEK is wrapped under the current
 * generation's wrapping key (see docs/encryption.md).
 */

import type { Context, Hono } from 'npm:hono@4'

import type { SqliteClient } from './admin.ts'
import { isAdminToken } from './admin.ts'
import {
  COMMENT_COLUMNS_SQL,
  decryptRowAuthor,
  decryptRows,
  notAuthorMessage,
  notFoundMessage,
  selectComment,
  selectCommentWithReplies,
  serverMissingDbKeyMessage,
} from './comment-store.ts'
import { encrypt, importKey, randomDataKeyBytes, wrapKey } from './crypto.ts'
import type { WrappingKeyContext } from './keys.ts'
import { resolveReaderAccess } from './session.ts'
import type { ReaderAccessConfig } from './session.ts'
import type {
  ApiComment,
  BaseComment,
  ExportedComment,
  ExportedComments,
} from '../types.ts'

export type CommentDeps = {
  sqlite: SqliteClient
  ensureDb: () => Promise<void>
  /**
   * Lowercased email domains permitted to read a private
   * walkthrough's comments. Empty refuses every reader.
   */
  allowedDomains: readonly string[]
  /**
   * Is this walkthrough private? Wired to `lib/visibility.ts`'s
   * recorded flag, which answers from an indexed row rather than a
   * blob probe. An unrecorded slug resolves to private.
   */
  isSlugPrivate: (slug: string) => Promise<boolean>
  /**
   * `MEANDER_JWT_SECRET`. Empty means no reader cookie or session
   * token verifies, so a private walkthrough's comments refuse
   * every caller short of the admin token.
   */
  jwtSecret: string
  /**
   * Resolve the authenticated email from the request, or undefined.
   */
  currentUser: (c: Context) => Promise<string | undefined>
  /**
   * Gate a request: returns an error + status when the caller may
   * not proceed, or undefined when they may. `operation` names the
   * action in the denial message ('writes' when omitted).
   */
  authRequired: (
    email: string | undefined,
    options?: { operation?: string | undefined } | undefined,
  ) => { error: string; status: 401 | 403 } | undefined
  /**
   * The val's `MEANDER_ADMIN_TOKEN`. Empty string means no caller
   * can present admin credentials, so every gated route falls back
   * to the user-session check.
   */
  adminToken: string
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

/**
 * Narrow the comment deps to what the reader-identity resolver
 * reads. Mirrors `lib/pages.ts`'s `readerAccessConfig`, so a page
 * and its comment thread accept exactly the same credentials.
 */
export function commentReaderConfig(deps: CommentDeps): ReaderAccessConfig {
  return {
    adminToken: deps.adminToken,
    allowedDomains: deps.allowedDomains,
    jwtSecret: deps.jwtSecret,
  }
}

/**
 * Gate one comment read. Returns the refusal to render, or
 * undefined when the caller may proceed.
 *
 * A public walkthrough's comments are readable with no credential
 * at all — that is the common case, and the one a mistaken gate
 * would break loudest. A private walkthrough's comments want the
 * slug's reader cookie, a comment-API session token, or the val's
 * admin token, the same three `lib/pages.ts` accepts for the prose.
 */
export async function refuseCommentRead(
  c: Context,
  deps: CommentDeps,
  slug: string,
): Promise<{ error: string; status: 401 | 403 } | undefined> {
  if (!(await deps.isSlugPrivate(slug))) {
    return undefined
  }
  const access = await resolveReaderAccess(
    c.req,
    slug,
    commentReaderConfig(deps),
  )
  if (access.granted) {
    return undefined
  }
  return { error: access.reason, status: access.status }
}

/**
 * Register the comment routes on the Hono app. Returns the same app
 * for chainability — matches Hono's idiom (and `registerAdminRoutes`).
 */
export function registerCommentRoutes(app: Hono, deps: CommentDeps): Hono {
  app.get('/:slug/api/comments/unresolved', async c => {
    await deps.ensureDb()
    const slug = c.req.param('slug')
    const refused = await refuseCommentRead(c, deps, slug)
    if (refused) {
      return c.json({ error: refused.error }, refused.status)
    }
    if (!deps.keyContext) {
      return c.json(
        { error: serverMissingDbKeyMessage(deps.keyContextError) },
        500,
      )
    }
    const result = await deps.sqlite.execute({
      sql: `${COMMENT_COLUMNS_SQL} WHERE slug = :slug AND resolved = 0 AND parent_id IS NULL ORDER BY part ASC, created_at ASC`,
      args: { slug },
    })
    return c.json(await decryptRows(result.rows, deps.keyContext))
  })

  app.get('/:slug/api/comments', async c => {
    await deps.ensureDb()
    const slug = c.req.param('slug')
    const refused = await refuseCommentRead(c, deps, slug)
    if (refused) {
      return c.json({ error: refused.error }, refused.status)
    }
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
      sql: `${COMMENT_COLUMNS_SQL} WHERE slug = :slug AND part = :part ORDER BY created_at ASC`,
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
     * stored on the row so a future read knows which key to use.
     */
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
    const caller = await resolveCaller(c, deps, 'writes')
    if (caller.denied) {
      return c.json({ error: caller.denied.error }, caller.denied.status)
    }
    const slug = c.req.param('slug')
    const id = c.req.param('id')
    const body = await c.req.json()
    const { resolved } = body
    if (typeof resolved !== 'boolean') {
      return c.json({ error: 'resolved field (boolean) required' }, 400)
    }
    if (!deps.keyContext) {
      return c.json(
        { error: serverMissingDbKeyMessage(deps.keyContextError) },
        500,
      )
    }
    const target = await selectComment(deps.sqlite, slug, id)
    if (!target) {
      return c.json({ error: notFoundMessage(id, slug) }, 404)
    }
    if (!caller.admin) {
      const author = await decryptRowAuthor(target, deps.keyContext)
      if (author !== caller.email) {
        return c.json({ error: notAuthorMessage('resolve') }, 403)
      }
    }
    await deps.sqlite.execute({
      sql: 'UPDATE comments SET resolved = :resolved WHERE id = :id AND slug = :slug',
      args: { id, slug, resolved: resolved ? 1 : 0 },
    })
    return c.json({ ok: true, id, resolved })
  })

  /* Deleting a root comment deletes its replies with it. Orphaning
   * them behind a dangling parent_id would retain rows nothing can
   * reach: the export walks roots and skips them, and the thread UI
   * has no anchor to hang them under. A thread is the unit a reader
   * sees, so it is the unit that goes. Deleting a reply removes
   * only that reply.
   */
  app.delete('/:slug/api/comments/:id', async c => {
    await deps.ensureDb()
    const caller = await resolveCaller(c, deps, 'writes')
    if (caller.denied) {
      return c.json({ error: caller.denied.error }, caller.denied.status)
    }
    const slug = c.req.param('slug')
    const id = c.req.param('id')
    if (!deps.keyContext) {
      return c.json(
        { error: serverMissingDbKeyMessage(deps.keyContextError) },
        500,
      )
    }
    const rows = await selectCommentWithReplies(deps.sqlite, slug, id)
    const target = rows.find(row => row.id === id)
    if (!target) {
      return c.json({ error: notFoundMessage(id, slug) }, 404)
    }
    if (!caller.admin) {
      const author = await decryptRowAuthor(target, deps.keyContext)
      if (author !== caller.email) {
        return c.json({ error: notAuthorMessage('delete') }, 403)
      }
    }
    await deps.sqlite.execute({
      sql: 'DELETE FROM comments WHERE slug = :slug AND (id = :id OR parent_id = :id)',
      args: { slug, id },
    })
    return c.json({ ok: true, id, deleted: rows.length })
  })

  /* The export decrypts every body + author for a slug and streams
   * them as plaintext, so it is gated exactly like a write: a
   * session on an allowed domain, or the val's admin token for a
   * headless backup job.
   */
  app.get('/:slug/api/comments/export', async c => {
    await deps.ensureDb()
    const caller = await resolveCaller(c, deps, 'export')
    if (caller.denied) {
      return c.json({ error: caller.denied.error }, caller.denied.status)
    }
    const slug = c.req.param('slug')
    const unresolvedOnly = c.req.query('unresolved') === 'true'
    if (!deps.keyContext) {
      return c.json(
        { error: serverMissingDbKeyMessage(deps.keyContextError) },
        500,
      )
    }

    let sql = `${COMMENT_COLUMNS_SQL} WHERE slug = :slug`
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

/**
 * Resolve who is calling a gated route. `admin` means the request
 * carried the val's admin token; otherwise `email` is the session
 * identity and `denied` is set when the session may not proceed.
 */
export async function resolveCaller(
  c: Context,
  deps: CommentDeps,
  operation: string,
): Promise<{
  admin: boolean
  email: string | undefined
  denied: { error: string; status: 401 | 403 } | undefined
}> {
  if (isAdminToken(c, deps.adminToken)) {
    return { admin: true, email: undefined, denied: undefined }
  }
  const email = await deps.currentUser(c)
  return {
    admin: false,
    email,
    denied: deps.authRequired(email, { operation }),
  }
}
