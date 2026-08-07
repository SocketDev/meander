# Comment API

The deployed val exposes a small REST API. Comment reads are open on
a public walkthrough, so every visitor sees existing discussions; on
an encrypted one they take the same credentials the prose does.
Writes and the bulk export require a signed-in session on any
walkthrough. One val can host many walkthroughs - every query is
scoped by `slug`, so a comment id from one walkthrough does not
resolve against another.

## Auth endpoints

| Method   | Path                      | What it does                                         |
| -------- | ------------------------- | ---------------------------------------------------- |
| `POST`   | `/api/auth/request`       | Email a 6-digit magic code.                          |
| `POST`   | `/api/auth/verify`        | Verify the code; returns a session JWT.              |
| `GET`    | `/api/auth/me`            | Echo the authenticated email + demo-mode flag.       |
| `POST`   | `/:slug/api/auth/session` | Verify the code; sets the reader cookie for `:slug`. |
| `DELETE` | `/:slug/api/auth/session` | Expire that cookie.                                  |

`/:slug/api/auth/session` is the page-reading counterpart of
`/api/auth/verify`. It takes the same `{ email, code }`, returns
the same `{ token, email }`, and additionally sets the `HttpOnly`
cookie that unlocks an encrypted walkthrough's pages for a browser
navigation. The sign-in page the val serves on a refused private
walkthrough drives it. See
[encryption.md](./encryption.md) for the cookie's shape and scope.

### Magic-code flow

1. `POST /api/auth/request { email }` - the val checks the email
   domain against `MEANDER_ALLOWED_EMAIL_DOMAINS`, mints a
   6-digit code, stores a SHA-256 hash of it in SQLite, and
   emails the code via Val Town's built-in email.
2. `POST /api/auth/verify { email, code }` - the val checks the
   code (max 5 attempts, 10-minute expiry) and returns
   `{ token, email }`. The one-shot code is deleted after a
   successful match.
3. The client stores the token in `localStorage` and attaches
   it to every write as `Authorization: Bearer <token>`. Tokens
   expire after 30 days.

Rejection reasons the client can surface:

- `403` from `/api/auth/request` - email domain not allowed, or
  the server has no `MEANDER_ALLOWED_EMAIL_DOMAINS` configured
  (fresh-deploy safe default).
- `401` from `/api/auth/verify` - wrong code.
- `429` from `/api/auth/verify` - too many failed attempts; user
  needs to request a fresh code.

## Comment endpoints

| Method   | Path                             | What it does                                                        |
| -------- | -------------------------------- | ------------------------------------------------------------------- |
| `GET`    | `/:slug/api/comments?part=N`     | Fetch all comments for part `N` of `:slug`. **Reader gate.**        |
| `POST`   | `/:slug/api/comments`            | Create a new comment or a reply. **Auth required.**                 |
| `PATCH`  | `/:slug/api/comments/:id`        | Mark `:id` resolved / unresolved. **Author or admin.**              |
| `DELETE` | `/:slug/api/comments/:id`        | Delete comment `:id` and its replies. **Author or admin.**          |
| `GET`    | `/:slug/api/comments/unresolved` | List every open (unresolved) root comment. **Reader gate.**         |
| `GET`    | `/:slug/api/comments/export`     | Download all comments for `:slug` as JSON. **Auth or admin token.** |

Auth-required routes check for `Authorization: Bearer <jwt>`.
No header → `401`. Bad / expired token → `401`. Domain not on
the allowlist → `403`.

**Reader gate** means the route is open to everyone on a public
walkthrough and takes one of three credentials on an encrypted one:
the slug's `meander_read` cookie, a session token on `Authorization`,
or `MEANDER_ADMIN_TOKEN`. Refusals are `401` with no credential and
`403` when the identity's domain is off the allowlist, and the body
carries the reason and nothing else. This is the gate
[encryption.md](./encryption.md) puts on the pages, applied to the
discussion of them. A walkthrough with no recorded visibility is
treated as private.

The `author` field on a POST is **not** honored - the server
stamps the authenticated email. Clients can't spoof a different
name through the API.

### Ownership

`PATCH` and `DELETE` resolve `:id` only within `:slug`, and only
for the session that authored the comment. An id that belongs to
a different walkthrough reads as `404`; a comment authored by
someone else is `403`. `Authorization: Bearer <MEANDER_ADMIN_TOKEN>`
overrides both checks, so an operator can clear anything.

Deleting a root comment deletes its replies with it. Orphaned
replies would be retained but unreachable - the export walks
roots, and the thread UI has nothing to hang them under - so the
thread is the unit that goes. Deleting a reply removes only that
reply. The response reports the count: `{ ok, id, deleted }`.

### Export auth

The export returns every comment body and author identity for a
slug, decrypted. It takes either identity:

- A session JWT, same as the write routes. The in-page export
  button sends this - it fetches the JSON and saves it through an
  object URL, because a plain link download can't carry the
  `Authorization` header.
- `Authorization: Bearer <MEANDER_ADMIN_TOKEN>`, for a headless
  backup job. The magic-code flow needs a human mailbox, so a
  scheduled export uses the admin token instead.

## Storage

Comments live in a Val Town SQLite database. Each row carries:

- `id`, `slug`, `part`, `file`, `line_from`, `line_to`, `parent_id`,
  `resolved`, `created_at` - plaintext, for indexing + filtering.
- `body`, `author` - encrypted with AES-256-GCM under a per-row
  data key.
- `dek_wrapped`, `key_generation` - the per-row data key, wrapped
  under `MEANDER_DB_KEY_<key_generation>`. See
  [encryption.md](./encryption.md) for the envelope scheme + the
  rotation lifecycle.

Magic codes live in a separate `magic_codes` table with `email`
primary key. Stores a salted SHA-256 hash of the code, not the
code itself - leaking this table doesn't leak any user's code.

## Admin endpoints

The val exposes a small `/admin/*` surface used by the
`meander db key` ceremonies. All admin routes require
`Authorization: Bearer <MEANDER_ADMIN_TOKEN>`. The admin token
is minted by `deploy-val` and read back by the ceremonies via
the operator's Val Town API token.

| Method | Path               | Purpose                                                                                                                        |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/admin/key-audit` | Per-generation row counts + the current pointer.                                                                               |
| `POST` | `/admin/rewrap`    | Re-wrap rows from one generation to another. Body: `{ fromGeneration, toGeneration, batchSize? }`. Idempotent + cursor-driven. |

Comment ciphertext is never decrypted on these routes - only
each row's small wrapped DEK moves. See
[operating.md](./operating.md) for the rotation runbook.

## Demo mode

When the val boots with `MEANDER_DEMO_MODE=true`, every write
route returns `403 {"error": "demo mode — writes disabled"}`,
regardless of the caller's session, and the export returns
`403 {"error": "demo mode — export disabled"}`. Reads still work
under their own gate - demo mode disables writes, and a demo
deployment still serves what a visitor may read. The served HTML
carries `data-demo-mode="true"` on
the `<body>` so the client can render a banner + disable the
composer.

The admin token bypasses demo mode on the routes that accept it -
it is an operator credential, not a visitor session.
