/**
 * Walkthrough page routes for the val — the slug index, the
 * walkthrough HTML itself, and the reader sign-in that unlocks an
 * encrypted one.
 *
 * Registered from a `Deps` struct the same way `lib/comments.ts`
 * and `lib/admin.ts` are, so Node tests drive the real handlers
 * without pulling val-town's `https://esm.town/...` imports in at
 * test time. `assets/val/index.ts` builds the struct at module load
 * from Deno.env, `std/blob`, and the magic-code table.
 *
 * Reader gating, in one sentence: a walkthrough is private exactly
 * when its stored blob is envelope-encrypted, and a private
 * walkthrough is served only to a caller who proves an allowed
 * identity for that slug.
 *
 * Deciding on the blob rather than on config means the gate cannot
 * drift from what was actually published. `encryptBlobs: false`
 * uploads plaintext, the `ENVELOPE:` prefix is absent, and the page
 * stays public with no sign-in — the common case, and the one a
 * mistaken gate would break loudest.
 *
 * Endpoints:
 * GET    /                        Slug index. Public walkthroughs always;
 * private ones only for a caller who
 * can prove access to them.
 * GET    /:slug                   Redirect to /:slug/.
 * GET    /:slug/                  Walkthrough index page.
 * GET    /:slug/documents         Documents page.
 * GET    /:slug/part/:id          One part.
 * POST   /:slug/api/auth/session  Trade a magic code for the slug's
 * reader cookie.
 * DELETE /:slug/api/auth/session  Expire that cookie.
 */

import type { Context, Hono } from 'npm:hono@4'

import { identityGate } from './auth.ts'
import { decrypt, importKey, unpackEnvelope, unwrapKey } from './crypto.ts'
import { escapeHtmlText, renderLoginPage } from './login-page.ts'
import type { MagicCodeOutcome } from './magic-code.ts'
import {
  clearedReaderCookie,
  mintReaderToken,
  mintSessionToken,
  readerCookie,
  resolveReaderAccess,
} from './session.ts'
import type { ReaderAccessConfig } from './session.ts'
import { blobTextIsEncrypted } from './visibility.ts'

export type PageDeps = {
  /**
   * The val's `MEANDER_ADMIN_TOKEN`. Empty disables the admin path
   * into private pages.
   */
  adminToken: string
  allowedDomains: readonly string[]
  /**
   * The val's `MEANDER_BLOB_KEY`, or undefined when blob
   * encryption is not configured. Undefined also means no blob on
   * this deployment can be both encrypted and servable, which is
   * what lets the slug index skip probing entirely.
   */
  blobKey: () => Promise<CryptoKey> | undefined
  /**
   * Check a magic code and burn it. Wraps `lib/magic-code.ts`'s
   * `consumeMagicCode` with the val's sqlite client.
   */
  consumeMagicCode: (email: string, code: string) => Promise<MagicCodeOutcome>
  jwtSecret: string
  /**
   * Every slug with blobs under the deployment's out-dir, sorted.
   */
  listSlugs: () => Promise<string[]>
  /**
   * Blob text for a key relative to the out-dir, or undefined when
   * the blob does not exist.
   */
  readBlobText: (relativeKey: string) => Promise<string | undefined>
}

/**
 * Is this walkthrough's stored HTML envelope-encrypted? Decided by
 * `lib/visibility.ts`'s oracle, the same one the comment gate reads
 * through.
 *
 * A slug with no index blob answers false here. The index route is
 * this function's only caller, and a slug it cannot fetch is one it
 * has nothing to hide: listing it costs a visitor a 404, while
 * treating it as private would hide a public walkthrough whose blob
 * read merely raced a publish.
 */
export async function isEncryptedSlug(
  deps: PageDeps,
  slug: string,
): Promise<boolean> {
  const text = await deps.readBlobText(`${slug}/index.html`)
  if (text === undefined) {
    return false
  }
  return blobTextIsEncrypted(text)
}

/**
 * Narrow the page deps to what the identity resolver reads.
 */
export function readerAccessConfig(deps: PageDeps): ReaderAccessConfig {
  return {
    adminToken: deps.adminToken,
    allowedDomains: deps.allowedDomains,
    jwtSecret: deps.jwtSecret,
  }
}

/**
 * Register the page + reader-session routes. Returns the same app
 * for chainability, matching Hono's idiom.
 */
export function registerPageRoutes(app: Hono, deps: PageDeps): Hono {
  /* The index lists what the caller may actually open. Public
   * walkthroughs are listed for everyone; a private one is listed
   * only when the caller can already read it, so the index never
   * advertises the existence of prose they cannot see.
   *
   * A browser sees no private slugs here even when signed in: the
   * reader cookie is scoped to `/<slug>/` and is not sent to `/`.
   * That is the intended trade — a private walkthrough is reached
   * by its URL, and the deployment-wide index stays a public
   * surface. An API client presenting a session token or the admin
   * token on `Authorization` sees the full list. */
  app.get('/', async c => {
    let slugs: string[]
    try {
      slugs = await deps.listSlugs()
    } catch {
      return c.text('Error listing walkthroughs', 500)
    }
    /* No blob key means nothing on this deployment decrypts, so
     * every slug is public and the per-slug probe below is skipped
     * — the index costs one blob listing, as it always did. */
    const blobKey = await deps.blobKey()
    const visible: string[] = []
    for (let i = 0, { length } = slugs; i < length; i += 1) {
      const slug = slugs[i]!
      if (!blobKey || !(await isEncryptedSlug(deps, slug))) {
        visible.push(slug)
        continue
      }
      const access = await resolveReaderAccess(
        c.req,
        slug,
        readerAccessConfig(deps),
      )
      if (access.granted) {
        visible.push(slug)
      }
    }
    const links = visible
      .map(
        s =>
          `<li><a href="/${encodeURIComponent(s)}/">${escapeHtmlText(s)}</a></li>`,
      )
      .join('\n')
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Walkthroughs</title>
<link rel="stylesheet" href="/meander.css"></head>
<body><header class="topbar"><h1>Walkthroughs</h1></header>
<main style="padding:16px;max-width:900px;"><ul>${links || '<li>No walkthroughs available.</li>'}</ul></main></body></html>`
    return c.html(html)
  })

  app.get('/:slug/', async c => {
    const slug = c.req.param('slug')
    return serveWalkthroughPage(c, deps, slug, `${slug}/index.html`)
  })

  app.get('/:slug', async c => {
    const slug = c.req.param('slug')
    return c.redirect(`/${slug}/`, 301)
  })

  app.get('/:slug/documents', async c => {
    const slug = c.req.param('slug')
    return serveWalkthroughPage(c, deps, slug, `${slug}/documents.html`)
  })

  app.get('/:slug/part/:id', async c => {
    const slug = c.req.param('slug')
    const id = c.req.param('id')
    return serveWalkthroughPage(c, deps, slug, `${slug}/part-${id}.html`)
  })

  /* Trade a magic code for the slug's reader cookie. The code
   * itself comes from POST /api/auth/request, which is
   * deployment-wide: the code proves an email, and the slug in
   * this route's path is what the resulting cookie is bound to. */
  app.post('/:slug/api/auth/session', async c => {
    const slug = c.req.param('slug')
    if (!deps.jwtSecret) {
      return c.json({ error: 'server missing MEANDER_JWT_SECRET' }, 500)
    }
    const body = await c.req.json().catch(() => ({}))
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    if (!email || !code) {
      return c.json({ error: 'email + code required' }, 400)
    }
    /* Check the allowlist before the code, so an email that could
     * never be granted access does not burn its own code. */
    const denied = identityGate(
      email,
      deps.allowedDomains,
      'reading this walkthrough',
    )
    if (denied) {
      return c.json({ error: denied.error }, denied.status)
    }
    const outcome = await deps.consumeMagicCode(email, code)
    if (!outcome.ok) {
      return c.json({ error: outcome.error }, outcome.status)
    }
    const reader = await mintReaderToken(email, slug, deps.jwtSecret)
    const token = await mintSessionToken(email, deps.jwtSecret)
    c.header('Set-Cookie', readerCookie(reader, slug))
    c.header('Cache-Control', 'private, no-store')
    return c.json({ ok: true, email, token })
  })

  /* Sign out of one walkthrough. The cookie is HttpOnly, so
   * clearing it is a server round trip rather than something the
   * page can do on its own. */
  app.delete('/:slug/api/auth/session', async c => {
    const slug = c.req.param('slug')
    c.header('Set-Cookie', clearedReaderCookie(slug))
    c.header('Cache-Control', 'private, no-store')
    return c.json({ ok: true })
  })

  return app
}

/**
 * Serve one walkthrough blob.
 *
 * A plaintext blob is public and goes out as-is. An
 * envelope-encrypted blob is private: the caller is resolved
 * first, and a refusal returns the sign-in page carrying the
 * refusal's status, so a browser lands somewhere it can act and a
 * script still sees 401/403. Nothing is decrypted before the gate
 * decides.
 *
 * Failure to decrypt — wrong key, malformed envelope — surfaces as
 * a 500 so misconfiguration does not silently serve garbage.
 */
export async function serveWalkthroughPage(
  c: Context,
  deps: PageDeps,
  slug: string,
  relativeKey: string,
) {
  const text = await deps.readBlobText(relativeKey)
  if (text === undefined) {
    return c.text('Not found', 404)
  }
  let envelope: { wrappedDek: string; ciphertext: string } | undefined
  try {
    envelope = unpackEnvelope(text)
  } catch {
    return c.text('Server error: malformed encrypted blob', 500)
  }
  if (!envelope) {
    return c.html(text)
  }
  const access = await resolveReaderAccess(
    c.req,
    slug,
    readerAccessConfig(deps),
  )
  if (!access.granted) {
    c.header('Cache-Control', 'private, no-store')
    return c.html(
      renderLoginPage({ reason: access.reason, slug }),
      access.status,
    )
  }
  const blobKey = await deps.blobKey()
  if (!blobKey) {
    return c.text(
      'Server error: encrypted blob present but MEANDER_BLOB_KEY is unset',
      500,
    )
  }
  try {
    const dekBytes = await unwrapKey(envelope.wrappedDek, blobKey)
    const dek = await importKey(dekBytes)
    const html = await decrypt(envelope.ciphertext, dek)
    c.header('Cache-Control', 'private, no-store')
    return c.html(html)
  } catch {
    return c.text('Server error: blob decrypt failed', 500)
  }
}
