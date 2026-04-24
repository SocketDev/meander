# Comment API

The deployed val exposes a small REST API that the browser client
uses to read, write, resolve, and export comments. Every route is
scoped by walkthrough `slug` so one val can host multiple
walkthroughs without conflict.

## Endpoints

| Method   | Path                                | What it does                                      |
| -------- | ----------------------------------- | ------------------------------------------------- |
| `GET`    | `/:slug/api/comments?part=N`        | Fetch all comments for part `N` of `:slug`.       |
| `POST`   | `/:slug/api/comments`               | Create a new comment or a reply.                  |
| `PATCH`  | `/:slug/api/comments/:id`           | Mark `:id` resolved or unresolved.                |
| `DELETE` | `/:slug/api/comments/:id`           | Delete comment `:id`.                             |
| `GET`    | `/:slug/api/comments/unresolved`    | List every open (unresolved) root comment.        |
| `GET`    | `/:slug/api/comments/export`        | Download all comments for `:slug` as JSON.        |

## Storage

Comments live in a Val Town SQLite database. Each row carries:

- `id`, `slug`, `part`, `file`, `line_from`, `line_to`, `parent_id`,
  `resolved`, `created_at` — plaintext, for indexing + filtering.
- `body`, `author` — encrypted with AES-256-GCM (see
  [encryption.md](./encryption.md) for key derivation + binary
  format).

A single val can serve many walkthroughs — rows are isolated by
`slug`, so adding another walkthrough is a new `slug` + republish,
not a new deploy.

## Auth

Writes (POST/PATCH/DELETE) are gated behind HTTP basic auth, using
`WALKTHROUGH_USER` + `WALKTHROUGH_PASS` on the val's env. Reads
are open (so unauthenticated readers can see discussions) but the
plan is to move writes to an email magic-code flow — see the open
auth work in the repo's task list.
