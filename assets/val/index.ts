/**
 * Walkthrough Val — Hono HTTP handler.
 *
 * Serves walkthrough HTML out of Val Town blob storage and
 * manages comments via SQLite, with email magic-code auth for
 * writes. Reads are open (unauthenticated visitors can see
 * discussions); writes require an authenticated session token.
 *
 * Required env vars (set by `meander deploy-val`):
 *   MEANDER_ENCRYPTION_KEY         Password derived into the AES-256-GCM key
 *                                  for at-rest encryption of HTML + comment
 *                                  body/author fields. Rotate means re-publish.
 *   MEANDER_JWT_SECRET             Random secret used to sign session JWTs.
 *                                  Generate once; rotating invalidates every
 *                                  active login session.
 *
 * Optional env vars:
 *   MEANDER_ALLOWED_EMAIL_DOMAINS  Comma-separated allowlist, e.g.
 *                                  "gmail.com,socket.dev". Empty / unset
 *                                  means writes are refused — the safe
 *                                  default for a fresh deploy.
 *   MEANDER_OUT_DIR                Blob-key prefix (default: "pages").
 *                                  Must match what publish emits.
 *   MEANDER_DEMO_MODE              When "true", composer is still
 *                                  enabled but comments return a 403 at
 *                                  write time. UI shows a banner.
 *
 * Blob key conventions:
 *   <outDir>/<slug>/index.html           encrypted
 *   <outDir>/<slug>/part-<N>.html        encrypted
 *   <outDir>/<slug>/documents.html       encrypted (when documents configured)
 *   <outDir>/<slug>/manifest.json        plaintext
 *   <outDir>/meander.css                 plaintext
 */

import { blob } from 'https://esm.town/v/std/blob'
import { sqlite } from 'https://esm.town/v/std/sqlite/main.ts'
import { Hono } from 'npm:hono@4'
import type { Context } from 'npm:hono@4'
import {
  emailDomainAllowed,
  hashCode,
  parseAllowedDomains,
  sixDigitCode,
} from './lib/auth.ts'
import { decrypt, deriveKey, encrypt } from './lib/crypto.ts'
import { signJwt, verifyJwt } from './lib/jwt.ts'
import type {
  ApiComment,
  BaseComment,
  ExportedComment,
  ExportedComments,
} from './types.ts'

const app = new Hono()

/* ------------------------------------------------------------------ */
/*  Config                                                              */
/* ------------------------------------------------------------------ */

const OUT_DIR = (Deno.env.get('MEANDER_OUT_DIR') || 'pages').replace(/\/$/, '')
const CRYPTO_PASS = Deno.env.get('MEANDER_ENCRYPTION_KEY') || ''
const JWT_SECRET = Deno.env.get('MEANDER_JWT_SECRET') || ''
const ALLOWED_EMAIL_DOMAINS = parseAllowedDomains(
  Deno.env.get('MEANDER_ALLOWED_EMAIL_DOMAINS'),
)
const DEMO_MODE = Deno.env.get('MEANDER_DEMO_MODE') === 'true'

/* ------------------------------------------------------------------ */
/*  Crypto + JWT                                                        */
/* ------------------------------------------------------------------ */

const cryptoKeyPromise = CRYPTO_PASS ? deriveKey(CRYPTO_PASS) : null

/** Mint a 30-day session JWT with the caller's email. */
async function mintSession(email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({ email, iat: now, exp: now + 60 * 60 * 24 * 30 }, JWT_SECRET)
}

/** Verify a token and return the email claim, or null. */
async function readSession(token: string): Promise<string | null> {
  const payload = await verifyJwt(token, JWT_SECRET)
  if (!payload || typeof payload['email'] !== 'string') {
    return null
  }
  return payload['email']
}

/* ------------------------------------------------------------------ */
/*  Database init + magic-code helpers                                  */
/* ------------------------------------------------------------------ */

let dbInitialized = false

async function ensureDb() {
  if (dbInitialized) return
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS comments (
      id         TEXT PRIMARY KEY,
      slug       TEXT NOT NULL,
      part       INTEGER NOT NULL,
      file       TEXT NOT NULL,
      line_from  INTEGER NOT NULL,
      line_to    INTEGER NOT NULL,
      author     TEXT NOT NULL,
      body       TEXT NOT NULL,
      parent_id  TEXT,
      resolved   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  await sqlite.execute(
    `CREATE INDEX IF NOT EXISTS idx_comments_slug_part ON comments(slug, part)`,
  )
  for (const col of ['parent_id TEXT', 'resolved INTEGER NOT NULL DEFAULT 0']) {
    try {
      await sqlite.execute(`ALTER TABLE comments ADD COLUMN ${col}`)
    } catch {
      /* Column already exists — ignore. */
    }
  }
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS magic_codes (
      email      TEXT PRIMARY KEY,
      code_hash  TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0
    )
  `)
  dbInitialized = true
}

/**
 * Send the magic code via Val Town's std/email. Falls back to
 * logging the code to stdout when the provider call fails (dev
 * deploys, offline testing) so setup isn't blocked.
 */
async function sendMagicCode(email: string, code: string): Promise<void> {
  const subject = 'Your meander sign-in code'
  const text = `Your sign-in code is: ${code}\n\nIt expires in 10 minutes.\n`
  try {
    const { email: sendEmail } = await import('https://esm.town/v/std/email')
    await sendEmail({ to: email, subject, text })
  } catch (e) {
    console.log(`[meander] email send failed, code for ${email}: ${code}`, e)
  }
}

/* ------------------------------------------------------------------ */
/*  Auth middleware                                                     */
/* ------------------------------------------------------------------ */

/**
 * Read the bearer token from `Authorization: Bearer <jwt>` and
 * verify it. Returns the email, or null (no token / bad token).
 */
async function currentUser(c: Context): Promise<string | null> {
  if (!JWT_SECRET) {
    return null
  }
  const auth = c.req.header('authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) {
    return null
  }
  return readSession(m[1]!)
}

function authRequired(
  email: string | null,
): { error: string; status: 401 | 403 } | null {
  if (DEMO_MODE) {
    return { error: 'demo mode — writes disabled', status: 403 }
  }
  if (!email) {
    return { error: 'authentication required', status: 401 }
  }
  if (ALLOWED_EMAIL_DOMAINS.length === 0) {
    return {
      error: 'writes disabled — server has no MEANDER_ALLOWED_EMAIL_DOMAINS',
      status: 403,
    }
  }
  if (!emailDomainAllowed(email, ALLOWED_EMAIL_DOMAINS)) {
    return { error: 'email domain not allowed', status: 403 }
  }
  return null
}

/* ------------------------------------------------------------------ */
/*  Auth routes                                                         */
/* ------------------------------------------------------------------ */

/**
 * POST /api/auth/request  { email }
 * Mints a 6-digit code, stores the hash, sends it via email.
 */
app.post('/api/auth/request', async c => {
  await ensureDb()
  const body = await c.req.json().catch(() => ({}))
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  if (!email || email.indexOf('@') < 0) {
    return c.json({ error: 'email required' }, 400)
  }
  if (ALLOWED_EMAIL_DOMAINS.length === 0) {
    return c.json(
      {
        error:
          'writes disabled — server has no MEANDER_ALLOWED_EMAIL_DOMAINS configured',
      },
      403,
    )
  }
  if (!emailDomainAllowed(email, ALLOWED_EMAIL_DOMAINS)) {
    return c.json({ error: 'email domain not allowed' }, 403)
  }
  const code = sixDigitCode()
  const codeHash = await hashCode(code, email)
  const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60
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
  await sendMagicCode(email, code)
  return c.json({ ok: true })
})

/**
 * POST /api/auth/verify  { email, code }
 * Returns { token } on success. Token goes in Authorization:
 * Bearer for subsequent write calls.
 */
app.post('/api/auth/verify', async c => {
  await ensureDb()
  if (!JWT_SECRET) {
    return c.json({ error: 'server missing MEANDER_JWT_SECRET' }, 500)
  }
  const body = await c.req.json().catch(() => ({}))
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const code = typeof body?.code === 'string' ? body.code.trim() : ''
  if (!email || !code) {
    return c.json({ error: 'email + code required' }, 400)
  }
  const row = (
    await sqlite.execute({
      sql: 'SELECT code_hash, expires_at, attempts FROM magic_codes WHERE email = :email',
      args: { email },
    })
  ).rows[0] as
    | { code_hash: string; expires_at: number; attempts: number }
    | undefined
  if (!row) {
    return c.json({ error: 'no code for this email' }, 400)
  }
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    return c.json({ error: 'code expired' }, 400)
  }
  if (row.attempts >= 5) {
    return c.json({ error: 'too many attempts; request a new code' }, 429)
  }
  const codeHash = await hashCode(code, email)
  if (codeHash !== row.code_hash) {
    await sqlite.execute({
      sql: 'UPDATE magic_codes SET attempts = attempts + 1 WHERE email = :email',
      args: { email },
    })
    return c.json({ error: 'invalid code' }, 401)
  }
  /* One-shot: delete the code after successful use. */
  await sqlite.execute({
    sql: 'DELETE FROM magic_codes WHERE email = :email',
    args: { email },
  })
  const token = await mintSession(email)
  return c.json({ token, email })
})

/**
 * GET /api/auth/me — echoes the authenticated email, or 401.
 * Useful for the client to check session freshness on load.
 */
app.get('/api/auth/me', async c => {
  const email = await currentUser(c)
  if (!email) {
    return c.json({ error: 'not authenticated' }, 401)
  }
  return c.json({ email, demoMode: DEMO_MODE })
})

/* ------------------------------------------------------------------ */
/*  Shared CSS                                                          */
/* ------------------------------------------------------------------ */

app.get('/meander.css', async c => serveBlobText(c, 'meander.css', 'text/css'))

/* ------------------------------------------------------------------ */
/*  Root — list available walkthroughs                                 */
/* ------------------------------------------------------------------ */

app.get('/', async c => {
  try {
    const blobs = await blob.list(`${OUT_DIR}/`)
    const slugs = new Set<string>()
    for (const b of blobs) {
      /* Keys look like <OUT_DIR>/<slug>/index.html. The shared
       * CSS file lives at <OUT_DIR>/meander.css — its key has
       * only two segments, so the slug branch skips it. */
      const parts = b.key.split('/')
      if (parts.length >= 3 && parts[0] === OUT_DIR) {
        slugs.add(parts[1]!)
      }
    }
    const links = [...slugs]
      .map(s => `<li><a href="/${s}/">${s}</a></li>`)
      .join('\n')
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Walkthroughs</title>
<link rel="stylesheet" href="/meander.css"></head>
<body><header class="topbar"><h1>Walkthroughs</h1></header>
<main style="padding:16px;max-width:900px;"><ul>${links || '<li>No walkthroughs published yet.</li>'}</ul></main></body></html>`
    return c.html(html)
  } catch {
    return c.text('Error listing walkthroughs', 500)
  }
})

/* ------------------------------------------------------------------ */
/*  Walkthrough pages                                                   */
/* ------------------------------------------------------------------ */

app.get('/:slug/', async c => {
  const slug = c.req.param('slug')
  return serveEncryptedHtml(c, `${slug}/index.html`)
})

app.get('/:slug', async c => {
  const slug = c.req.param('slug')
  return c.redirect(`/${slug}/`, 301)
})

app.get('/:slug/documents', async c => {
  const slug = c.req.param('slug')
  return serveEncryptedHtml(c, `${slug}/documents.html`)
})

app.get('/:slug/part/:id', async c => {
  const slug = c.req.param('slug')
  const id = c.req.param('id')
  return serveEncryptedHtml(c, `${slug}/part-${id}.html`)
})

/* ------------------------------------------------------------------ */
/*  Comments API                                                        */
/* ------------------------------------------------------------------ */

app.get('/:slug/api/comments/unresolved', async c => {
  await ensureDb()
  const slug = c.req.param('slug')
  const cryptoKey = await requireCryptoKey(c)
  if (!cryptoKey) return
  const result = await sqlite.execute({
    sql: 'SELECT id, slug, part, file, line_from, line_to, author, body, parent_id, resolved, created_at FROM comments WHERE slug = :slug AND resolved = 0 AND parent_id IS NULL ORDER BY part ASC, created_at ASC',
    args: { slug },
  })
  return c.json(await decryptRows(result.rows, cryptoKey))
})

app.get('/:slug/api/comments', async c => {
  await ensureDb()
  const slug = c.req.param('slug')
  const part = c.req.query('part')
  if (!part) {
    return c.json({ error: 'part query parameter required' }, 400)
  }
  const cryptoKey = await requireCryptoKey(c)
  if (!cryptoKey) return
  const result = await sqlite.execute({
    sql: 'SELECT id, slug, part, file, line_from, line_to, author, body, parent_id, resolved, created_at FROM comments WHERE slug = :slug AND part = :part ORDER BY created_at ASC',
    args: { slug, part: parseInt(part, 10) },
  })
  return c.json(await decryptRows(result.rows, cryptoKey))
})

app.post('/:slug/api/comments', async c => {
  await ensureDb()
  const email = await currentUser(c)
  const deny = authRequired(email)
  if (deny) {
    return c.json({ error: deny.error }, deny.status)
  }
  const cryptoKey = await requireCryptoKey(c)
  if (!cryptoKey) return

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
  /* Author is the authenticated email — clients can't spoof it. */
  const encryptedAuthor = await encrypt(email!, cryptoKey)
  const encryptedBody = await encrypt(commentBody, cryptoKey)
  const id = crypto.randomUUID()
  await sqlite.execute({
    sql: 'INSERT INTO comments (id, slug, part, file, line_from, line_to, author, body, parent_id) VALUES (:id, :slug, :part, :file, :lineFrom, :lineTo, :author, :body, :parentId)',
    args: {
      id,
      slug,
      part: partInt,
      file,
      lineFrom: lineFromInt,
      lineTo: lineToInt,
      author: encryptedAuthor,
      body: encryptedBody,
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
      parentId: parentId || null,
      resolved: false,
      createdAt: new Date().toISOString(),
    },
    201,
  )
})

app.patch('/:slug/api/comments/:id', async c => {
  await ensureDb()
  const email = await currentUser(c)
  const deny = authRequired(email)
  if (deny) {
    return c.json({ error: deny.error }, deny.status)
  }
  const id = c.req.param('id')
  const body = await c.req.json()
  const { resolved } = body
  if (typeof resolved !== 'boolean') {
    return c.json({ error: 'resolved field (boolean) required' }, 400)
  }
  await sqlite.execute({
    sql: 'UPDATE comments SET resolved = :resolved WHERE id = :id',
    args: { id, resolved: resolved ? 1 : 0 },
  })
  return c.json({ ok: true, id, resolved })
})

app.delete('/:slug/api/comments/:id', async c => {
  await ensureDb()
  const email = await currentUser(c)
  const deny = authRequired(email)
  if (deny) {
    return c.json({ error: deny.error }, deny.status)
  }
  const id = c.req.param('id')
  await sqlite.execute({
    sql: 'DELETE FROM comments WHERE id = :id',
    args: { id },
  })
  return c.json({ ok: true })
})

app.get('/:slug/api/comments/export', async c => {
  await ensureDb()
  const slug = c.req.param('slug')
  const unresolvedOnly = c.req.query('unresolved') === 'true'
  const cryptoKey = await requireCryptoKey(c)
  if (!cryptoKey) return

  let sql =
    'SELECT id, slug, part, file, line_from, line_to, author, body, parent_id, resolved, created_at FROM comments WHERE slug = :slug'
  if (unresolvedOnly) {
    sql += ' AND resolved = 0'
  }
  sql += ' ORDER BY part ASC, file ASC, line_from ASC, created_at ASC'
  const result = await sqlite.execute({ sql, args: { slug } })
  const comments = await decryptRows(result.rows, cryptoKey)

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

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

async function requireCryptoKey(c: Context): Promise<CryptoKey | null> {
  if (!cryptoKeyPromise) {
    c.status(500)
    c.json({ error: 'server missing MEANDER_ENCRYPTION_KEY' })
    return null
  }
  return cryptoKeyPromise
}

async function decryptRows(
  rows: readonly unknown[],
  key: CryptoKey,
): Promise<ApiComment[]> {
  return Promise.all(
    rows.map(async (raw: any) => ({
      id: raw.id,
      slug: raw.slug,
      part: raw.part,
      file: raw.file,
      lineFrom: raw.line_from,
      lineTo: raw.line_to,
      author: await decrypt(raw.author, key),
      body: await decrypt(raw.body, key),
      parentId: raw.parent_id || null,
      resolved: !!raw.resolved,
      createdAt: raw.created_at,
    })),
  )
}

async function serveBlobText(c: Context, key: string, contentType: string) {
  try {
    const data = await blob.get(`${OUT_DIR}/${key}`)
    const text = await data.text()
    return c.text(text, 200, {
      'Content-Type': `${contentType}; charset=utf-8`,
    })
  } catch {
    return c.text('Not found', 404)
  }
}

async function serveEncryptedHtml(c: Context, relativeKey: string) {
  if (!cryptoKeyPromise) {
    return c.text('server missing MEANDER_ENCRYPTION_KEY', 500)
  }
  const cryptoKey = await cryptoKeyPromise
  try {
    const data = await blob.get(`${OUT_DIR}/${relativeKey}`)
    const encrypted = await data.text()
    const html = await decrypt(encrypted, cryptoKey)
    return c.html(html)
  } catch {
    return c.text('Not found', 404)
  }
}

/* ------------------------------------------------------------------ */
/*  Export                                                              */
/* ------------------------------------------------------------------ */

export default app.fetch
