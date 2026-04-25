# Operating

Day-2 runbook for a deployed meander val. Covers rotation cadence,
restoration drills, custodian responsibilities, and the failure
modes you'll actually hit.

For the encryption design itself, see
[encryption.md](./encryption.md). For first-time deploy, see
[deploying.md](./deploying.md).

## Custodian responsibilities

The Shamir shares printed by `db key init` and `blob key init`
are the **only** recoverable copies of the wrapping keys. Each
custodian must:

1. **Store their share durably** in a place independent of every
   other custodian. Examples that count as independent:
   - Personal password manager (1Password, Bitwarden, etc.)
   - Paper printout in a fire-safe box
   - Hardware token's secure note slot
   - Offsite backup (safety-deposit box, family member's safe)

   Examples that *do not* count as independent:
   - Multiple entries in the same password vault
   - Email + Google Drive (same account)
   - Two laptops syncing to the same iCloud / OneDrive

2. **Be reachable** for the rotation cadence — a custodian who
   takes weeks to respond is a 1/threshold liability.

3. **Recognize and refuse social engineering**. Never share over
   chat, email, or screen-share without a verified out-of-band
   confirmation. A share leak doesn't break the threshold by
   itself, but it lowers it: leaking 1 share in a 2-of-3 split
   means a single additional leak compromises the key.

4. **Test their share once a year**. The CLI's `restore` command
   doesn't write any state — it's safe to run as a drill (see
   "Restoration drill" below).

## Rotation cadence

Rotate the comment-store wrapping key on:

- **Suspected compromise** — share leak, custodian device theft,
  Val Town platform incident touching env vars.
- **Custodian change** — someone leaves and held a share. Rotate
  to invalidate their (now decommissioned) share.
- **Annual hygiene** — even with no incident, rotate yearly to
  exercise the procedure and catch share-storage decay before
  it matters.

Rotate the blob wrapping key on:

- **Same triggers as comment-store** plus:
- **Any time you re-publish** is fine — blobs are regenerable, so
  rotating + re-publishing is cheap.

## Comment-store rotation runbook

```bash
# 0. Make sure custodians can produce `threshold` shares NOW. Don't
#    start the rotation until you've verified the shares exist.

# 1. Audit current state.
meander db key audit walkthrough
# Visible generations: 1
# Current (used for new writes): 1
# Row counts by generation:
#   generation 1: 1284 row(s) ← current

# 2. Run rotate. Will prompt for `threshold` shares.
meander db key rotate walkthrough --threshold 2

# 3. While rotation runs, distribute the new shares it prints to
#    custodians (replace each custodian's old share). DO NOT delete
#    the old shares yet — if the new rotation fails partway, the
#    old shares are your fallback.

# 4. Confirm rotation finished by re-auditing.
meander db key audit walkthrough
# Visible generations: 1, 2
# Current (used for new writes): 2
# Row counts by generation:
#   generation 2: 1284 row(s) ← current
#   generation 1: 0 rows — eligible for `meander db key retire 1`

# 5. Wait 24-48 hours (catches any in-flight writes that were mid-
#    transaction at rotation time, gives you a bailout window).
#    During this period the old key still works for any rows that
#    might still reference it.

# 6. Retire the old generation.
meander db key retire walkthrough --generation 1
# Removed MEANDER_DB_KEY_1

# 7. Tell custodians to destroy / delete their copies of the old
#    shares. They should keep only the generation-2 share.
```

If step 2 reports a stalled rewrap, re-run it. The `/admin/rewrap`
endpoint is idempotent + cursor-driven; resuming after an
interruption picks up where it stopped.

If step 2 fails the share-verification check ("reconstructed key
does not match"), you've supplied wrong shares. Nothing on the
val has changed. Double-check share provenance and try again.

## Blob wrapping key rotation runbook

```bash
# 0. Same prerequisite — custodians ready.

# 1. Run rotate. Prompts for shares.
meander blob key rotate walkthrough --threshold 2

# 2. Update your local env to the new key. The CLI prints the
#    exact `export` line; copy it.
export MEANDER_BLOB_KEY=<new-hex-from-output>

# 3. Re-publish. Until you do, every existing encrypted blob in
#    Val Town storage is unreadable (the val's key no longer
#    matches the wrapped DEKs in the blobs).
meander publish meander.config.json

# 4. Distribute the new shares to custodians. Old shares can be
#    destroyed once you've confirmed `meander publish` completed
#    + the val serves blobs again.
```

If you need to abort mid-rotation: re-run `meander blob key
rotate` and supply the *new* shares it just printed. The current
key is whatever's last planted on the val.

## Restoration drill

Practice once per quarter. No state changes — `restore` is a
no-op when shares match the val's existing key.

```bash
# Pick `threshold` custodians. Each one extracts their share
# from wherever it's stored. The drill is over once the command
# reports "Shares match existing MEANDER_DB_KEY_<n> — nothing
# to restore".

meander db key restore walkthrough --threshold 2
# Share 1 of 2 (base58, 2 remaining): <paste>
# Share 2 of 2 (base58, 1 remaining): <paste>
#   Shares match existing MEANDER_DB_KEY_1 — nothing to restore
```

If the command reports a mismatch, your share storage has drifted
from what the val holds. Either:

- A share has been corrupted at rest (storage decay, manual
  retyping error). Replace the bad copy from a custodian who
  has a known-good copy, or rotate to retire the corrupted
  share entirely.
- The val's env was rotated without all custodians being
  updated. Find the most recent rotation's shares.

## Recovery from env-var loss

The val's env was wiped (Val Town incident, accidental delete,
fresh deploy from a clean slate). Comment ciphertext is intact in
SQLite, but with no wrapping key, nothing decrypts.

```bash
meander db key restore walkthrough --threshold 2
# (interactive: prompts for 2 shares)
#   Set MEANDER_DB_KEY_1
#   Set MEANDER_DB_KEY_CURRENT=1
```

After this, the val resumes serving comments normally. No data
loss. No comment ciphertext was decrypted in the recovery — only
the wrapping key was reconstituted.

For the blob key:

```bash
meander blob key restore walkthrough --threshold 2
# Reads `threshold` shares, plants MEANDER_BLOB_KEY on the val.

# Then update your local env so future publishes work:
export MEANDER_BLOB_KEY=$(meander blob key show walkthrough)
```

## Failure modes

**Comments stop decrypting (500 errors on /api/comments/...).**
Check the val's env first:

```bash
# A misconfigured generation pointer is the most common cause —
# MEANDER_DB_KEY_CURRENT pointing at a generation that doesn't
# have a matching MEANDER_DB_KEY_<n> set.
meander db key audit walkthrough
```

If audit succeeds and reports sane state, the problem is somewhere
else (val process down, sqlite issue). If audit fails, the
error message points at which env var is missing.

**Comment writes return 401 / 403.** Auth, not encryption — see
[deploying.md](./deploying.md) for `MEANDER_ALLOWED_EMAIL_DOMAINS`
and `MEANDER_DEMO_MODE`.

**`meander db key rotate` reports "rewrap stalled".** A row's
DEK couldn't be unwrapped — usually means the row was written
under a generation no longer in env. Check audit output;
restore the missing generation if shares are available.

**`meander blob key show` succeeds but `meander publish` fails
"MEANDER_BLOB_KEY must be 64 hex characters".** The `show` output
includes a trailing newline; the env var picked up the newline.
Use `$(meander blob key show ...)` (command substitution strips
trailing newlines) instead of pasting raw.

## Backup strategy

The val's SQLite is hosted on Val Town's infrastructure. Their
durability is generally good but not your-only-copy good. Two
backup paths, neither built into meander today:

- **Comment export**: `GET /:slug/api/comments/export` (auth
  required) returns a JSON dump of all comments for a slug,
  decrypted server-side. Useful for migrating off Val Town or
  archiving discussions; not appropriate as a daily backup
  (round-trips full plaintext through the val).

- **SQLite dump via Val Town's data UI**: a manual backup option
  if you want a full snapshot. Contains ciphertext only — useless
  without the wrapping key.

A scheduled-export GitHub Action that runs against
`/api/comments/export` and commits the JSON to a private backup
repo is a reasonable follow-up if your discussion volume justifies
it.

## When to involve which custodian

| Operation                     | Threshold custodians needed |
| ----------------------------- | --------------------------- |
| Read comments (val running)   | 0                           |
| Read comments (val env wiped) | `threshold` (db key restore)|
| New comment writes            | 0                           |
| Annual rotation               | `threshold`                 |
| Suspected compromise rotation | `threshold`                 |
| Add a new custodian           | `threshold` (rotate to issue new shares) |
| Remove a custodian            | `threshold` (rotate; old shares decommissioned) |
| Retire an old generation      | 0 (no shares — val-only)    |
| Audit                         | 0 (no shares — val-only)    |

Most day-to-day operation needs zero custodian involvement.
Custodians are only invoked for rotation, restoration, and
security incidents.
