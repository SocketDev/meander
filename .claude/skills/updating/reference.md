# updating reference

Extended detail for the `updating` skill — how each update target
works, where the configuration lives, and troubleshooting notes.

## Table of contents

1. [Update targets](#update-targets)
2. [npm dependency updates](#npm-dependency-updates)
3. [external-tools.json refresh](#external-toolsjson-refresh)
4. [Manual updates](#manual-updates)
5. [Future sibling skills](#future-sibling-skills)
6. [Validation](#validation)
7. [Troubleshooting](#troubleshooting)

---

## Update targets

| Target | Mode | Source of truth |
|---|---|---|
| npm packages | automatic | `package.json` + `pnpm-lock.yaml` |
| External binaries | automatic | `external-tools.json` |
| highlight.js CDN pin | manual | `src/generate.mts` (string literals + SRI hashes) |
| Favicon assets | manual | `assets/favicon/*` (regenerate from `favicon.svg`) |
| Logo variants | manual | `assets/logo/*` (regenerate from `logo-black.svg`) |

The skill auto-runs the first two and surfaces the third as a
checklist. The favicon/logo regenerators are out of scope —
they're not "dependency updates," they're asset edits, and they
only run when the master SVG changes.

---

## npm dependency updates

### How `pnpm run update` works

`scripts/update.mts` runs three steps:

```bash
# 1. taze with the fleet config — non-Socket deps, 7-day cooldown.
pnpm exec taze

# 2. taze again, scoped to Socket-owned packages, no cooldown.
pnpm exec taze \
  --include "@socketregistry/*,@socketsecurity/*,@socketdev/*,socket-*,ecc-agentshield,sfw" \
  --maturity-period 0 \
  --write

# 3. Resync lockfile against the updated package.json.
pnpm install
```

Two passes are required because taze's config auto-discovery is
path-based and doesn't support a `--config` override; the
exclusion list lives in `.config/taze.config.mts` and the second
pass overrides it via CLI flags.

### Why two passes

- **Pass 1** uses `maturityPeriod: 7` from `.config/taze.config.mts`
  with Socket-owned scopes in `exclude`. This is the
  ecosystem-cooldown window — a non-Socket package has to be
  stable for 7 days before this repo bumps to it. Catches
  compromised upstream releases before they propagate.
- **Pass 2** force-bumps Socket-owned packages with
  `maturityPeriod: 0`. We trust our own publish pipeline (provenance,
  internal review), so Socket releases land immediately.

The `SOCKET_SCOPES` array in `scripts/update.mts` has to stay
in lockstep with the `exclude` list in
`.config/taze.config.mts`. If they drift, packages either get
double-bumped or missed entirely.
Both lists live next to comments calling out the invariant.

### Files that may change

- `package.json` — version pins (all deps are pinned exact)
- `pnpm-lock.yaml` — lockfile

---

## external-tools.json refresh

### Layout

`external-tools.json` (repo root) pins binary tools that aren't
delivered as npm packages: pnpm, sfw, zizmor, ecc-agentshield.
Each entry tracks a version, an upstream GitHub repo, and
per-platform asset/sha256 pairs:

```json
{
  "zizmor": {
    "description": "GitHub Actions security linter",
    "repository": "github:zizmorcore/zizmor",
    "version": "1.23.1",
    "release": "asset",
    "checksums": {
      "darwin-arm64": { "asset": "...", "sha256": "..." },
      ...
    }
  }
}
```

The schema is validated by `scripts/validate-tools.mts`, which
runs as part of `pnpm run check`.

### How `scripts/update-tools.mts` works

For each entry in `external-tools.json`:

1. Fetch the upstream repo's `releases/latest` from the GitHub API.
2. If the latest version isn't strictly newer than the pinned
   version (semver compare, prerelease-aware), skip.
3. Download every per-platform asset; compute sha256.
4. Patch `external-tools.json` in place with the new version +
   checksums. Missing assets keep the previous slot so a release
   that drops a platform doesn't break the others.

Idempotent: re-running with everything current produces an
unchanged file and exit 0.

### Authentication

`scripts/update-tools.mts` reads `GH_TOKEN` or `GITHUB_TOKEN`
from the environment. CI provides this automatically; locally
either run `gh auth status` first (the script doesn't shell out
to `gh`, but having gh logged in indicates token availability)
or export `GH_TOKEN` for the run.

### When it fires

- The `updating` skill runs it after the npm pass.
- The `weekly-update.yml` workflow runs it after `pnpm run update`
  inside the same job, so a new pnpm/zizmor/sfw release rolls into
  the same chore PR as the npm bumps.

---

## Manual updates

### highlight.js CDN pin

Lives in `src/generate.mts` (around the `HLJS_CDN` constant). The
file pins three URLs at `@highlightjs/cdn-assets@11.11.1`:

- `styles/github-dark.min.css`
- `highlight.min.js`
- `languages/typescript.min.js` (TypeScript grammar so `@example`
  blocks highlight correctly)

Each URL has a corresponding SRI integrity hash (sha384) used as
the `integrity="..."` attribute on the rendered `<script>` /
`<link>`. A CDN compromise that flips the bytes will fail
verification and the browser refuses to load the asset.

To bump the pin:

1. Choose a new `@highlightjs/cdn-assets@<version>`.
2. Update the three URLs in `HLJS_CDN`.
3. Recompute each integrity hash:
   ```bash
   curl -sL https://unpkg.com/@highlightjs/cdn-assets@<v>/highlight.min.js \
     | openssl dgst -sha384 -binary | base64
   ```
4. Smoke-test in dev preview (`pnpm dev`) that highlighted code
   blocks still render. Specifically check a `@example` fenced
   `typescript` block — that's the case the grammar load enables.

The CDN pin is *not* part of `pnpm run update` because it's a
URL string, not a package version. The `updating` skill mentions
it on every run as a manual checklist item.

### Favicon and logos (out of scope)

These are asset edits, not dependency updates. Regenerate them
from their masters when the source SVG changes; see the
`scripts/` regenerator helpers and `CLAUDE.md` § Assets pipeline.

---

## Future sibling skills

Add a new `updating-<thing>` skill under `.claude/skills/` when:

- The update target has its own state machine (e.g. compute a
  hash, edit a file, run a smoke test).
- It's frequent enough that capturing the procedure pays off.
- It can run unattended (no interactive review needed).

When you add one, hook it into Phase 4 of `SKILL.md`:

```
Skill({ skill: "updating-<your-name>" })
```

A plausible candidate is `updating-hljs-cdn`: poll npm for the
latest `@highlightjs/cdn-assets`, download the three pinned files,
compute sha384 hashes, write the patch into `src/generate.mts`,
and run `pnpm run check`. Until that exists, the manual checklist
in Phase 6 is the only mechanism.

---

## Validation

After every automatic phase, the skill (in interactive mode) runs:

```bash
pnpm run check
```

Which is `scripts/check.mts` — lint (`oxlint`), type-check (`tsc`),
and `node scripts/validate-tools.mts` (schema-validates
`external-tools.json`).

CI mode skips this — `weekly-update.yml` runs the equivalent in a
separate job step.

---

## Troubleshooting

### taze reports nothing despite known bumps

**Cause:** the 7-day maturity period in `.config/taze.config.mts`.
A package that just published won't show up until day 8.

**Action:** wait, or — for a Socket-owned package — confirm it's
in the `SOCKET_SCOPES` array in both `scripts/update.mts` and
`.config/taze.config.mts`. The second pass should catch it.

### `update-tools.mts` fails "asset not found"

**Cause:** an upstream release dropped one of the platforms we
track (e.g. removed the linux-arm64 build).

**Action:** the script logs a warning and keeps the previous
slot. If the platform is genuinely deprecated, update
`external-tools.json` by hand to remove the entry; otherwise file
an issue upstream.

### `update-tools.mts` rate-limited by GitHub

**Cause:** unauthenticated GitHub API calls cap at 60/hour.

**Action:** export `GH_TOKEN` (or `GITHUB_TOKEN`) before re-running.

### Lockfile conflicts after pass 2

**Symptom:** `pnpm install` errors after the Socket-scope force-bump.

**Action:**
```bash
rm pnpm-lock.yaml
pnpm install
```

### highlight.js CDN bump breaks `<code>` rendering

**Cause:** a new hljs major can rename CSS classes or rework the
language registration API.

**Action:** revert the URL bump, smoke-test in dev preview against
the pinned `@example` typescript block, then upgrade more
deliberately. Don't ship a hljs bump without rendering both a
fenced `typescript` and a fenced `bash` block at minimum.
