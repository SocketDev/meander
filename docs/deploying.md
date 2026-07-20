# Deploying

Meander has two deploy targets, used independently:

- **GitHub Pages** for walkthrough HTML — the common case. No
  Val Town involvement, no encryption, GitHub gates access via
  Pages permissions.
- **Val Town** for the comment backend (a small Hono val) — the
  server that handles email magic-code auth, JWT sessions, and
  the SQLite comment store.

Optionally, Val Town can also host walkthrough HTML blobs (in
addition to or instead of GitHub Pages). That path is opt-in via
`encryptBlobs: true` in `meander.config.json` and adds a separate
key ceremony. See [encryption.md](./encryption.md) for the
threat model.

## Val Town setup

### Prerequisites

- A Val Town account.
- A Val Town API token — create one at
  [val.town/settings/api](https://val.town/settings/api).

### Token scopes

Meander uses the token in two places, with different scope
needs:

| Command              | Scope needed                                |
| -------------------- | ------------------------------------------- |
| `meander deploy-val` | `val:write` (create/update vals + env vars) |
| `meander publish`    | `blob:write` (upload walkthrough HTML)      |
| `meander db key *`   | `val:write` (manage val env vars)           |
| `meander blob key *` | `val:write` (manage val env vars)           |

For CI deploys of the comment backend (via
`.github/workflows/valtown.yml`), scope the token to
**`val:write` only** — nothing broader. No blob, no user. The
publish workflow needs `blob:write` separately.

Rotate by minting a new token and deleting the old one in Val
Town → Settings → API Tokens. Update the GitHub secret under
`Settings → Secrets and variables → Actions`.

### Environment variables

```bash
export VALTOWN_TOKEN=vtwn_...
```

- `VALTOWN_TOKEN` — the API token you just created. If your CI
  uses a different secret name, set
  `MEANDER_VALTOWN_TOKEN_ENV=MY_NAME` or pass `--token-env MY_NAME`
  to the CLI.

The val itself reads several env vars, all set by `meander
deploy-val` or one of the key ceremonies:

| Var                             | Set by                           | Purpose                                                        |
| ------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| `MEANDER_JWT_SECRET`            | `deploy-val` (preserved)         | Signs session tokens. Rotation logs every user out.            |
| `MEANDER_ADMIN_TOKEN`           | `deploy-val` (preserved)         | Authorizes `/admin/*` endpoints used by `db key` ceremonies.   |
| `MEANDER_ALLOWED_EMAIL_DOMAINS` | `deploy-val`                     | Comma-separated allowlist for comment writes. Empty → refused. |
| `MEANDER_OUT_DIR`               | `deploy-val`                     | Blob-key prefix (default `pages`).                             |
| `MEANDER_DEMO_MODE`             | `deploy-val` (`--demo-mode`)     | When `true`, writes return 403 + the UI shows a banner.        |
| `MEANDER_DB_KEY_<n>`            | `meander db key init / rotate`   | Comment-store wrapping key, generation N. Hex-encoded.         |
| `MEANDER_DB_KEY_CURRENT`        | `meander db key init / rotate`   | Integer pointing at the current generation.                    |
| `MEANDER_BLOB_KEY`              | `meander blob key init / rotate` | Blob wrapping key (only when `encryptBlobs: true`).            |

`deploy-val` and the key ceremonies don't overlap: deploy-val
manages code + non-key config; the ceremonies own all key material.

## First-time deploy

Three steps, in order:

```bash
# 1. Deploy the val (creates it the first time, plants JWT secret +
#    admin token, sets allowed-domains).
meander deploy-val --allowed-domains=gmail.com,example.com

# 2. Mint the comment-store wrapping key. Custodians need to be
#    ready — this command prints shares immediately.
meander db key init walkthrough

# 3. Optional: if encryptBlobs: true in meander.config.json,
#    mint the blob wrapping key + add it to your local env.
meander blob key init walkthrough
export MEANDER_BLOB_KEY=$(meander blob key show walkthrough)
```

After step 2, the val accepts comment writes. After step 3, you
can `meander publish` with envelope-encrypted blobs.

### deploy-val flags

| Flag                      | Purpose                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `--allowed-domains=<csv>` | Email-domain allowlist for comment writes. Empty → writes refused.    |
| `--out-dir=<name>`        | Blob-key prefix (default `pages`). Must match what `publish` uses.    |
| `--demo-mode`             | Deploy with the demo banner + writes returning 403. Public showcases. |
| `--graceful`              | Skip + exit 0 instead of erroring when `VALTOWN_TOKEN` is unset.      |
| `--token-env=<NAME>`      | Override the env-var name to read the bearer token from.              |

## Publish loop (Val Town blob path, optional)

When you've configured `encryptBlobs: true` in `meander.config.json`
and minted `MEANDER_BLOB_KEY`:

```bash
meander generate meander.config.json
meander publish meander.config.json
```

`publish` envelope-encrypts each generated HTML blob (per-blob DEK,
wrapped under `MEANDER_BLOB_KEY`) and uploads to Val Town blob
storage under keys like `pages/<slug>/part-1.html`. The CSS file
is uploaded plaintext (browsers can't read encrypted CSS). After
publish, your walkthrough is live at:

```
https://<username>-<valname>.web.val.run/<slug>/
```

When `encryptBlobs: false` (the default), `publish` uploads
plaintext bytes — `MEANDER_BLOB_KEY` is not needed.

Re-run `generate` + `publish` whenever the source files or
annotations change. The val itself only needs `deploy-val` again
when you want to ship a new server version or change non-key
config.

## GitHub Pages publish

Walkthrough HTML can also be served from GitHub Pages. `meander
generate` emits to `<outDir>/` (default `pages/`); a Pages
workflow uploads that directory:

```yaml
# .github/workflows/pages.yml — see this repo's own example
- run: pnpm exec meander generate meander.config.json
- uses: actions/upload-pages-artifact@<sha>
  with:
    path: pages
```

Pages access control is GitHub's responsibility. Comments still
go through the Val Town val (cross-origin requests from the
Pages domain to `*.val.run`).

## How readers sign in

1. The embedded comment client shows a **Sign in to comment**
   button in the top bar.
2. Reader enters their email. The val sends a 6-digit code via
   Val Town's built-in email.
3. Reader enters the code. The val returns a JWT valid for 30
   days; the client stores it in `localStorage` and attaches it
   to every comment write.
4. Email domains outside `MEANDER_ALLOWED_EMAIL_DOMAINS` are
   rejected on both `/api/auth/request` and the server-side
   check before a write commits.

## Demo mode

```bash
meander deploy-val --demo-mode
```

Demo-mode deploys:

- Show a dismissible "demo mode — comments aren't saved" banner
  in the UI.
- Return 403 on every comment-write endpoint.
- Still serve every page + render the composer (so visitors see
  the full experience).

Good for public demos where you want to show off the comment UI
without collecting real discussions.

## Graceful CI skip

CI jobs without `VALTOWN_TOKEN` (fork PRs, demo setups) can pass
`--graceful` to `deploy-val` / `publish`. Meander logs a skip
message and exits 0 instead of failing the job:

```yaml
- run: node dist/cli.mjs publish meander.config.json --graceful
```

## Blob layout on Val Town

```
<outDir>/meander.css              shared, plaintext
<outDir>/<slug>/index.html        plaintext OR `ENVELOPE:1:...`
<outDir>/<slug>/part-<id>.html    plaintext OR `ENVELOPE:1:...`
<outDir>/<slug>/documents.html    plaintext OR `ENVELOPE:1:...`
<outDir>/<slug>/manifest.json     plaintext build summary
```

`<outDir>` defaults to `pages`. Override via
`meander.config.json`'s `outDir` field, and pass the same value
to `deploy-val --out-dir=…` so the val reads from the matching
prefix.

The val recognizes the `ENVELOPE:1:` prefix per-blob; you can
have a mix of plaintext + encrypted blobs under the same prefix
without breakage.

## Day-2 ops

See [operating.md](./operating.md) for the day-2 ops runbook —
key rotation, restoration drills, custodian responsibilities,
backup strategy.
