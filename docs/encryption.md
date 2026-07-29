# Encryption

Meander has two independent at-rest encryption stories: one for
the **comment store** (the val's SQLite), one for **walkthrough
HTML blobs** (Val Town blob storage, optional). Both use the same
envelope scheme but differ in lifecycle because the data classes
have different recoverability properties.

## At a glance

| Data class                         | Encrypted?                                                              | Key                  | Rotation                             |
| ---------------------------------- | ----------------------------------------------------------------------- | -------------------- | ------------------------------------ |
| Comment `body` + `author`          | Always (envelope)                                                       | `MEANDER_DB_KEY_<n>` | Re-wrap DEKs, atomic generation flip |
| Comment metadata (id, file, lines) | No (indexable plaintext)                                                | —                    | —                                    |
| Walkthrough HTML in Val Town blobs | Opt-in (`encryptBlobs`); at rest, and served only to a signed-in reader | `MEANDER_BLOB_KEY`   | Re-publish under a fresh key         |
| Walkthrough HTML on GitHub Pages   | No (Pages-gated access)                                                 | —                    | —                                    |
| `meander.css`, `manifest.json`     | No                                                                      | —                    | —                                    |
| Magic-code hashes                  | One-way SHA-256                                                         | (salted by email)    | One-shot, ten-minute expiry          |
| Session JWTs                       | Signed (HS256), not encrypted                                           | `MEANDER_JWT_SECRET` | Rotation logs every user out         |

## Threat model

What the encryption defends against:

- **Cold storage leak**: someone obtains a SQLite dump or a blob
  snapshot independent of the val process. Without the wrapping
  key, they get ciphertext only.
- **Val Town platform compromise**: an employee or an attacker
  with platform-level access reads stored data. Same defense:
  ciphertext only, until they also obtain the val's env.

What it does _not_ defend against:

- **Live val compromise**: an attacker with code execution inside
  the running val sees plaintext, because the val must decrypt to
  serve.
- **Anonymous reads of a plaintext walkthrough**: a walkthrough
  published without `encryptBlobs` is public, by design. Its pages
  and its `/` index entry are open to anyone with the URL.
- **Comment metadata on a private walkthrough**: a refused caller
  still learns the walkthrough exists and is private, and a comment
  read costs one indexed row lookup whose timing does not depend on
  how much discussion there is. The bodies, the author identities,
  and the count are gated; the fact of a gate is not.
- **Reader-side leakage**: anyone holding a valid session token can
  read every private walkthrough on the deployment and export every
  comment body and author identity for a slug in plaintext. The
  grant is "an allowed email domain", not a per-walkthrough ACL.
- **Custodian compromise**: if more than `(shares − threshold)`
  share-holders are compromised, the wrapping key is recoverable
  by an attacker.

## Envelope encryption — how the two layers fit

Both encryption stories use the same construction:

1. **Data Encryption Key (DEK)** — 32 random bytes. Encrypts the
   payload, a comment body or a walkthrough blob, with AES-256-GCM.
2. **Wrapping key** — 32 random bytes. Encrypts the DEK with
   AES-256-GCM. The wrapped DEK is stored alongside the
   ciphertext.

This is the standard NIST envelope pattern, also known as
"key-encryption keys + data-encryption keys" (KEK/DEK in
cryptographic literature; we call it _wrapping key_ + _data key_
because the term "KEK" carries unfortunate cultural baggage). The
benefit is that rotating the wrapping key only requires re-wrapping
the (small) DEKs — comment ciphertext is never decrypted in a
rotation.

Binary formats:

```text
Body ciphertext  [version 0x10] [12-byte IV] [ciphertext + 16-byte GCM tag]   base64
Wrapped DEK      [version 0x20] [12-byte IV] [32-byte ciphertext + 16-byte GCM tag]   base64
Envelope blob    "ENVELOPE:1:" + <wrappedDEK> + ":" + <body ciphertext>      ASCII
```

The version bytes (0x10, 0x20) are reserved; future migrations
can introduce new layouts without breaking older readers' version
checks. The blob envelope's `ENVELOPE:1:` prefix is a literal text
sentinel — the val recognizes it without parsing, and falls back
to "serve as plaintext" when the prefix is absent.

## Comment store — `MEANDER_DB_KEY_<n>` + `MEANDER_DB_KEY_CURRENT`

Comments are encrypted unconditionally. Each row in the val's
SQLite carries:

- `body`, `author` — encrypted under a per-row DEK.
- `dek_wrapped` — that DEK, wrapped under
  `MEANDER_DB_KEY_<key_generation>`.
- `key_generation` — integer pointing at which generation's
  wrapping key wrapped this row's DEK.

`MEANDER_DB_KEY_CURRENT` is the integer pointer used for **new**
writes. Old generations stay live until every row that references
them has been re-wrapped (rotation) and the generation is retired.

The lifecycle commands are under `meander db key`:

| Command                     | Effect                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meander db key init`       | First-time setup. Generates `MEANDER_DB_KEY_1`, plants `MEANDER_DB_KEY_CURRENT=1`, prints Shamir shares.                                                                                                  |
| `meander db key rotate`     | Reconstructs the current key from shares, mints `MEANDER_DB_KEY_<N+1>`, drives `/admin/rewrap` to re-wrap every row, atomically flips `MEANDER_DB_KEY_CURRENT`, prints new shares.                        |
| `meander db key restore`    | Reassembles a wrapping key from shares. Plants it when the val holds no generation (env-var loss); reports match or mismatch and writes nothing when it does. `--plant-new-generation` forces a new slot. |
| `meander db key audit`      | Prints visible generations, the current pointer, and per-generation row counts.                                                                                                                           |
| `meander db key retire <N>` | Removes `MEANDER_DB_KEY_<N>` from env. Pre-flights audit; refuses if any rows still reference generation N.                                                                                               |

The wrapping key never leaves the val after `init`. The operator's
machine doesn't hold it; only the custodians' shares do.

## Walkthrough blobs — `MEANDER_BLOB_KEY` (opt-in)

Most projects publish walkthroughs to **GitHub Pages**, where
GitHub's own access controls and at-rest encryption are sufficient
and Val Town blob storage isn't involved. For those projects,
walkthrough HTML encryption is irrelevant and not engaged.

Projects publishing to **Val Town blob storage** (`meander
publish`) opt in via `meander.config.json`:

```json
{
  "encryptBlobs": true
}
```

When enabled, `meander publish`:

1. Generates a per-blob DEK (random 32 bytes).
2. Encrypts the HTML with the DEK.
3. Wraps the DEK with the operator's `MEANDER_BLOB_KEY`.
4. Uploads `ENVELOPE:1:<wrappedDEK>:<ciphertext>`.

The val recognizes the `ENVELOPE:` prefix and decrypts before
serving. Plaintext blobs (no prefix) are served as-is. The val and
the operator both hold `MEANDER_BLOB_KEY`: the val needs it to
serve, the publisher needs it to encrypt.

`encryptBlobs` is both the at-rest control and the reader gate.
The encrypted bytes defend a cold blob-storage dump, covering a
Val Town platform compromise, an over-scoped API token, or a
leaked snapshot. The `ENVELOPE:` prefix is also what marks the
walkthrough private at serve time, so the two cannot drift apart:
the val decides on the blob it holds, not on a config value it was
told about.

### What a private walkthrough asks of a reader

A reader who opens `/:slug/` on an encrypted walkthrough gets a
sign-in page instead of the prose. Signing in emails them a
six-digit code (the same magic-code flow the comment composer
uses) and sets a reader cookie:

```text
meander_read=<jwt>; Path=/<slug>/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax
```

The cookie carries the grant because a top-level browser
navigation cannot carry an `Authorization` header. `HttpOnly`
keeps it out of reach of page scripts, `SameSite=Lax` lets it ride
a click from an email or a chat message while staying off
cross-site POSTs, and `Path=/<slug>/` means the browser never
offers walkthrough A's cookie on a request for walkthrough B. The
token's own `slug` claim is checked as well, so the scoping does
not rest on the browser honoring `Path`.

Three credentials open a private walkthrough: that cookie, a
comment-API session token on `Authorization: Bearer` (for scripts
and mirrors), and `MEANDER_ADMIN_TOKEN` (for headless jobs). All
three are re-checked against `MEANDER_ALLOWED_EMAIL_DOMAINS` on
every request, so removing a domain revokes the cookies already
issued to it. Rotating `MEANDER_JWT_SECRET` revokes all of them at
once.

`MEANDER_ALLOWED_EMAIL_DOMAINS` gates reads as well as writes. A
deployment with an empty allowlist serves its public walkthroughs
and refuses every private one, including to the operator.

### What stays visible without signing in

- `/meander.css`.
- Public walkthroughs: pages, parts, documents, their `/` index entries, and
  their comments via `GET /:slug/api/comments?part=N`.
- The existence of a slug, to anyone who guesses or is told the URL. The
  refusal page names the slug it is refusing.

A private walkthrough's comments take the same three credentials its
pages do — the slug's reader cookie, a session token on
`Authorization`, or the val's admin token — because a comment thread
carries prose and author identities of its own. The val answers "is
this walkthrough private?" from a `walkthrough_visibility` row rather
than by probing the blob, so a comment poll costs an index seek. See
[what records that row](#recording-which-walkthroughs-are-private).

The `/` index omits a private walkthrough from a caller who cannot
open it. A browser sees no private entries there even when signed
in, because the reader cookie is scoped to `/<slug>/` and is not
sent to `/`; a private walkthrough is reached by its URL. A client
presenting a session token or the admin token on `Authorization`
sees the full list.

Per-walkthrough authorization is not modeled: any reader on an
allowed email domain can sign in to any private walkthrough on the
deployment. The per-slug cookie bounds what one stolen credential
reaches, not what a legitimate reader may ask for. A deployment
that needs distinct audiences per walkthrough wants distinct vals.

### Recording which walkthroughs are private

Serving a page decides on the blob in hand: the `ENVELOPE:` prefix
is already in the bytes the val fetched to serve. A comment read has
no such luxury — it touches no blob, and fetching a whole encrypted
document to look at nine bytes would put a full blob GET behind
every poll of a comment thread.

So the val keeps a `walkthrough_visibility` table: one row per slug,
`slug` as the primary key, holding whether that walkthrough is
private. Two writers keep it true.

`meander publish` is the primary writer, because publishing is what
makes a walkthrough private. It marks a slug private **before**
uploading ciphertext and writes the settled value **after** the last
upload, so during a transition the recorded flag is the more
restrictive of the old and new states. Going public → private the
gate closes before the first private byte lands; going private →
public it opens once the plaintext is up. A write that fails aborts
the publish with a message naming the slug and the fix, rather than
reporting success over a stale flag.

The val is the second writer. Asked about a slug it has no row for,
it derives the answer from the blob store once, records it, and
answers from the row every time after. That is what carries a
deployment whose walkthroughs were published before the table
existed: an unrecorded slug is never assumed public.

Everything that cannot be resolved lands on private. No row and no
blob, or a blob store that will not answer, both refuse. That costs
an availability blip on a public walkthrough whose blob read failed;
the other way round would hand a private walkthrough's discussion to
anyone who asked.

The record is not a cache and carries no TTL. A TTL would fail open
for its whole window at the moment a walkthrough turns private,
which is the moment it must fail closed.

One residue: the flag reads stale-public if a private blob is
uploaded by something other than `meander publish` — a hand-written
blob, or a publish from a build that predates this table. Republish
with `meander publish` to settle it.

The lifecycle commands are under `meander blob key`:

| Command                    | Effect                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meander blob key init`    | First-time setup. Generates `MEANDER_BLOB_KEY`, plants it on the val, prints Shamir shares + a shell snippet.                                                                                                                |
| `meander blob key rotate`  | Reconstructs the current key from shares, mints a new key, plants it on the val, prints new shares + a shell snippet for the operator's local env. After rotation, re-publish (existing blobs become unreadable until then). |
| `meander blob key restore` | Reassembles `MEANDER_BLOB_KEY` from shares + plants it on the val. Used after env-var loss.                                                                                                                                  |
| `meander blob key show`    | Prints the val's current `MEANDER_BLOB_KEY` in hex. Bare output (pipe to `pbcopy` / a password manager).                                                                                                                     |

There's no rewrap dance for blobs because blobs are regenerable
from source. Rotation = re-publish, which the CLI prompts
explicitly.

## Custodial recovery — Shamir's Secret Sharing

Both ceremonies split their wrapping key with **Shamir's Secret
Sharing** before printing it. The operator distributes shares to
distinct custodians; reconstruction needs `threshold` of them.

Defaults: **2-of-3** (operator's password manager, paper printout
in a safe, second person's password manager). Tune via flags:

```bash
meander db key init --threshold 2 --shares 3   # default
meander db key init --threshold 3 --shares 5   # serious-org default
meander db key init --threshold 4 --shares 7   # belt-and-suspenders
```

Constraints:

- `threshold >= 2` (1-of-N is plaintext)
- `threshold <= shares`
- `shares <= 255` (GF(2^8) limit)

Shares are base58-encoded (Bitcoin alphabet — no `0/O/I/l`
ambiguity). The encoded form carries version + threshold + the
share's x-coordinate inline, so `combine()` validates without
external metadata.

What share-loss tolerance buys you:

- A 2-of-3 split tolerates losing **any one** custodian's share.
- A 3-of-5 split tolerates losing **any two**.
- A `T-of-S` split tolerates losing `S - T` shares.

What it costs: every share you add is one more place that can
_leak_. Custodian count should match real custodian independence —
five entries in the same password manager is one custodian, not
five.

## Recovery scenarios

**Lost the local copy of `MEANDER_DB_KEY_<n>`, but the val still
has it.** Nothing to recover — the val is the source of truth.
You only "lose" a `db key` because comments stop decrypting; if
they're decrypting, the val has the key.

**Lost the val's `MEANDER_DB_KEY_<n>` env var (it was wiped or
the val was deleted).** Reassemble from shares:

```bash
meander db key restore walkthrough --threshold 2
# (interactive: prompts for 2 shares)
```

**Lost more than `(shares - threshold)` shares.** The wrapping
key is unrecoverable. Comment ciphertext is permanently
undecryptable. Walkthrough blobs (if encrypted) are recoverable
only by re-publishing under a fresh `MEANDER_BLOB_KEY`.

**Suspected key compromise.** Rotate immediately:

```bash
meander db key rotate walkthrough --threshold 2
meander blob key rotate walkthrough --threshold 2     # if encryptBlobs: true
meander publish meander.config.json                    # re-publish blobs
```

The old generation stays in the val's env until you confirm via
audit + retire that no rows reference it anymore. After retire,
the old key is gone from the val and from local memory; only
shares remain, in custodian hands.

## Operator workflow

See [operating.md](./operating.md) for the runbook-format day-2
ops guide: rotation cadence, custodian responsibilities, backup
strategy, restoration drills.
