# Comment API

The deployed val exposes a small REST API. Reads are open (so
every visitor can see existing discussions); writes require a
signed-in session. One val can host many walkthroughs — rows are
isolated by `slug`.

## Auth endpoints

| Method   | Path                       | What it does                                        |
| -------- | -------------------------- | --------------------------------------------------- |
| `POST`   | `/api/auth/request`        | Email a 6-digit magic code.                         |
| `POST`   | `/api/auth/verify`         | Verify the code; returns a session JWT.             |
| `GET`    | `/api/auth/me`             | Echo the authenticated email + demo-mode flag.      |

### Magic-code flow

1. `POST /api/auth/request { email }` — the val checks the email
   domain against `MEANDER_ALLOWED_EMAIL_DOMAINS`, mints a
   6-digit code, stores a SHA-256 hash of it in SQLite, and
   emails the code via Val Town's built-in email.
2. `POST /api/auth/verify { email, code }` — the val checks the
   code (max 5 attempts, 10-minute expiry) and returns
   `{ token, email }`. The one-shot code is deleted after a
   successful match.
3. The client stores the token in `localStorage` and attaches
   it to every write as `Authorization: Bearer <token>`. Tokens
   expire after 30 days.

Rejection reasons the client can surface:

- `403` from `/api/auth/request` — email domain not allowed, or
  the server has no `MEANDER_ALLOWED_EMAIL_DOMAINS` configured
  (fresh-deploy safe default).
- `401` from `/api/auth/verify` — wrong code.
- `429` from `/api/auth/verify` — too many failed attempts; user
  needs to request a fresh code.

## Comment endpoints

| Method   | Path                                | What it does                                      |
| -------- | ----------------------------------- | ------------------------------------------------- |
| `GET`    | `/:slug/api/comments?part=N`        | Fetch all comments for part `N` of `:slug`.       |
| `POST`   | `/:slug/api/comments`               | Create a new comment or a reply. **Auth required.** |
| `PATCH`  | `/:slug/api/comments/:id`           | Mark `:id` resolved / unresolved. **Auth required.** |
| `DELETE` | `/:slug/api/comments/:id`           | Delete comment `:id`. **Auth required.**          |
| `GET`    | `/:slug/api/comments/unresolved`    | List every open (unresolved) root comment.        |
| `GET`    | `/:slug/api/comments/export`        | Download all comments for `:slug` as JSON.        |

Auth-required routes check for `Authorization: Bearer <jwt>`.
No header → `401`. Bad / expired token → `401`. Domain not on
the allowlist → `403`.

The `author` field on a POST is **not** honored — the server
stamps the authenticated email. Clients can't spoof a different
name through the API.

## Storage

Comments live in a Val Town SQLite database. Each row carries:

- `id`, `slug`, `part`, `file`, `line_from`, `line_to`, `parent_id`,
  `resolved`, `created_at` — plaintext, for indexing + filtering.
- `body`, `author` — encrypted with AES-256-GCM under a per-row
  data key.
- `dek_wrapped`, `key_generation` — the per-row data key, wrapped
  under `MEANDER_DB_KEY_<key_generation>`. See
  [encryption.md](./encryption.md) for the envelope scheme + the
  rotation lifecycle.

Magic codes live in a separate `magic_codes` table with `email`
primary key. Stores a salted SHA-256 hash of the code, not the
code itself — leaking this table doesn't leak any user's code.

## Admin endpoints

The val exposes a small `/admin/*` surface used by the
`meander db key` ceremonies. All admin routes require
`Authorization: Bearer <MEANDER_ADMIN_TOKEN>`. The admin token
is minted by `deploy-val` and read back by the ceremonies via
the operator's Val Town API token.

| Method | Path               | Purpose                                                                 |
| ------ | ------------------ | ----------------------------------------------------------------------- |
| `GET`  | `/admin/key-audit` | Per-generation row counts + the current pointer.                         |
| `POST` | `/admin/rewrap`    | Re-wrap rows from one generation to another. Body: `{ fromGeneration, toGeneration, batchSize? }`. Idempotent + cursor-driven. |

Comment ciphertext is never decrypted on these routes — only
each row's small wrapped DEK moves. See
[operating.md](./operating.md) for the rotation runbook.

## Demo mode

When the val boots with `MEANDER_DEMO_MODE=true`, every write
route returns `403 {"error": "demo mode — writes disabled"}`,
regardless of the caller's session. Reads still work. The
served HTML carries `data-demo-mode="true"` on the `<body>` so
the client can render a banner + disable the composer.
