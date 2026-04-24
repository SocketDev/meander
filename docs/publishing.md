# Publishing to Val Town

Meander ships generated HTML to [Val Town](https://val.town) as
encrypted blobs, served by a small Hono val. This doc walks
through the one-time setup and the publish loop.

## Prerequisites

- A Val Town account.
- A Val Town API token — create one at
  [val.town/settings/api](https://val.town/settings/api).

### Token scopes

Meander uses the token in two places, with different scope
needs:

| Command              | Scope needed                         |
| -------------------- | ------------------------------------ |
| `meander deploy-val` | `val:write` (create / update vals)   |
| `meander publish`    | `blob:write` (upload encrypted HTML) |

For CI deploys of the comment backend (via
`.github/workflows/valtown.yml`), scope the token to
**`val:write` only** — nothing broader. No blob, no user. The
publish workflow needs `blob:write` separately.

Rotate by minting a new token and deleting the old one in Val
Town → Settings → API Tokens. Update the GitHub secret under
`Settings → Secrets and variables → Actions`.

## Environment variables

```bash
export VALTOWN_TOKEN=vtwn_...
export MEANDER_ENCRYPTION_KEY='a-long-random-string'
```

- `VALTOWN_TOKEN` — the API token you just created. If your CI
  uses a different secret name, set
  `MEANDER_VALTOWN_TOKEN_ENV=MY_NAME` or pass `--token-env MY_NAME`
  to the CLI.
- `MEANDER_ENCRYPTION_KEY` — the password that derives the
  AES-256-GCM key encrypting walkthrough content at rest. See
  [encryption.md](./encryption.md) for the scheme. **Rotating
  means re-publishing every walkthrough**; the old ciphertext
  becomes undecryptable.

Meander's val uses **email magic-code auth** for comment writes,
not HTTP basic auth. Reads are open; writes require a signed-in
session. The val needs two more env vars, both set by
`meander deploy-val`:

- `MEANDER_JWT_SECRET` — random string signing session tokens.
  `deploy-val` generates it on first run and preserves it on
  subsequent deploys. Rotating it signs every user out.
- `MEANDER_ALLOWED_EMAIL_DOMAINS` — comma-separated list of
  domains the val accepts for sign-in. Empty / unset means the
  val refuses every write — the safe starting posture. Pass
  `--allowed-domains=gmail.com,example.com` to `deploy-val`.

## First-time deploy

```bash
meander deploy-val \
  --allowed-domains=gmail.com,example.com
```

This creates the Val Town val running the Hono server and pushes
the env vars the val needs. You only re-run `deploy-val` when
the server code changes or you want to update config; publishing
new walkthrough content is a separate step.

### deploy-val flags

- `--allowed-domains=<csv>` — email-domain allowlist for comment
  writes. Empty → writes refused.
- `--out-dir=<name>` — blob-key prefix (default `pages`). Must
  match what `meander publish` uses.
- `--demo-mode` — deploy with the demo banner + writes returning
  403. Good for public read-only showcases.
- `--graceful` — skip + exit 0 instead of erroring when the token
  isn't provisioned. For CI on fork PRs.

## Publish loop

```bash
meander generate meander.config.json
meander publish meander.config.json
```

`publish` encrypts the generated HTML files and uploads them to
Val Town blob storage under keys like `pages/<slug>/part-1.html`.
The CSS file is uploaded plaintext (browsers can't read an
encrypted stylesheet). After publish, your walkthrough is live
at:

```
https://<username>-<valname>.web.val.run/<slug>/
```

Re-run `generate` + `publish` whenever the source files or
annotations change. The val itself only needs `deploy-val` again
when you want to ship a new server version or change config.

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
<outDir>/<slug>/index.html        encrypted
<outDir>/<slug>/part-<id>.html    encrypted (one per part)
<outDir>/<slug>/documents.html    encrypted (when documents configured)
<outDir>/<slug>/manifest.json     plaintext build summary
```

`<outDir>` defaults to `pages`. Override via
`meander.config.json`'s `outDir` field, and pass the same value
to `deploy-val --out-dir=…` so the val reads from the matching
prefix.
