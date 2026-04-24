# Publishing to Val Town

Meander ships generated HTML to [Val Town](https://val.town) as
encrypted blobs, served by a small Hono val. This doc walks
through the one-time setup and the publish loop.

## Prerequisites

- A Val Town account.
- A Val Town API token — create one at
  [val.town/settings/api](https://val.town/settings/api). The
  token needs blob read/write scope (for HTML upload) and val
  manage scope (for `meander deploy-val`).

## Environment variables

```bash
export VALTOWN_TOKEN=vtwn_...
export WALKTHROUGH_USER=youruser
export WALKTHROUGH_PASS=yourpassword
```

- `VALTOWN_TOKEN` — the API token you just created. If your CI
  uses a different secret name, set `MEANDER_VALTOWN_TOKEN_ENV=MY_NAME`
  or pass `--token-env MY_NAME` to the CLI.
- `WALKTHROUGH_USER` / `WALKTHROUGH_PASS` — the HTTP basic-auth
  credentials the val will require from readers. `WALKTHROUGH_PASS`
  also derives the at-rest encryption key
  (see [encryption.md](./encryption.md)), so rotating the password
  means re-publishing every walkthrough.

> **Heads up:** email magic-code auth is on the roadmap. Basic
> auth is what's shipping today.

## First-time deploy

```bash
meander deploy-val
# or with a custom val name:
meander deploy-val my-walkthrough-val
```

This creates the Val Town val running the Hono server and sets
`WALKTHROUGH_USER` / `WALKTHROUGH_PASS` as the val's environment
variables. You only re-run `deploy-val` when the server code
changes — publishing new walkthrough content is a separate step.

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
when you want to ship a new server version.

## Graceful CI skip

CI jobs that don't have `VALTOWN_TOKEN` (fork PRs, demo setups)
can pass `--graceful` to `deploy-val` / `publish`. Meander will
log a skip message and exit 0 instead of failing the job:

```yaml
- run: node dist/cli.js publish meander.config.json --graceful
```

## Blob layout on Val Town

```
<outDir>/meander.css              shared, plaintext
<outDir>/<slug>/index.html        encrypted
<outDir>/<slug>/part-<id>.html    encrypted (one per part)
<outDir>/<slug>/documents.html    encrypted (when documents are configured)
<outDir>/<slug>/manifest.json     plaintext build summary
```

`<outDir>` defaults to `pages` and can be overridden via
`meander.config.json`'s `outDir` field. The val reads from the
same prefix, so both sides need to agree — `deploy-val` passes
the prefix to the val as a `MEANDER_OUT_DIR` env var. A backward-
compat read falls back to the legacy `walkthrough/` prefix if the
new key misses, so mid-rename deployments don't 404.
