---
name: updating
description: Orchestrates meander dependency updates — `pnpm run update`, `scripts/update-tools.mts`, `pnpm run check` — and flags the hljs CDN pin as a manual follow-up. Use for weekly maintenance.
user-invocable: true
allowed-tools: Task, Skill, Bash, Read, Grep, Glob, Edit
---

# updating

<task>
Update meander's automatic-update targets in order: npm packages
via `pnpm run update`, external binary tool checksums via
`scripts/update-tools.mts`, then `pnpm run check` to confirm
nothing broke. Surface manual-only updates (the highlight.js CDN
pin in `src/generate.mts`) so the operator can decide whether to
bump them. Future domain-specific siblings (e.g. an
`updating-hljs-cdn` skill) plug into Phase 4 of this skill.
</task>

<context>
This skill is meander's umbrella update orchestrator. It covers
the targets that can run unattended; manual targets are flagged
but not executed.

**Automatic targets:**
1. **npm packages** — `pnpm run update` runs `scripts/update.mts`,
   which is a two-pass taze pipeline (Socket-owned packages bypass
   the maturity window; everything else honors the 7-day cooldown
   in `.config/taze.config.mts`) followed by `pnpm install`.
2. **External binary tools** — `node scripts/update-tools.mts`
   refreshes `external-tools.json` checksums for pinned binaries
   (pnpm, sfw, zizmor, ecc-agentshield) by polling GitHub releases
   and recomputing per-platform sha256 hashes.

**Manual targets (flagged, not executed):**
3. **highlight.js CDN pin** — `src/generate.mts` pins
   `@highlightjs/cdn-assets@11.11.1` with three SRI integrity
   hashes (CSS, core JS, TypeScript grammar). Bumping the pin
   means recomputing the hashes via:
   ```bash
   curl -sL <url> | openssl dgst -sha384 -binary | base64
   ```
   This is *not* part of `pnpm run update` — the CDN pin is a
   string literal, not a package version. The skill mentions it
   but never auto-runs it.

**Sibling skills (future):**
Domain-specific updaters live as `updating-<thing>` siblings.
None ship today; if one appears (e.g. `updating-hljs-cdn`), Phase 4
of this skill is where the orchestration calls into it.
</context>

<constraints>
- Start from a clean working tree (no uncommitted changes).
- The `min-release-age=7` setting in `.npmrc` and `maturityPeriod: 7`
  in `.config/taze.config.mts` are security controls. Don't shorten
  or bypass them; the two-pass design already exempts Socket-owned
  scopes for trusted releases.

**CI mode** (detected via `CI=true` or `GITHUB_ACTIONS`):
- Create atomic commits, skip final build/test (CI runs them in
  separate jobs).
- The weekly-update workflow handles branch creation and PR.

**Interactive mode** (default):
- Run `pnpm run check` after each update phase to catch breakage
  early, before staging more changes.
</constraints>

<instructions>

## Process

### Phase 1: Validate environment

<action>
Confirm working tree is clean and detect CI mode.
</action>

```bash
if [ "$CI" = "true" ] || [ -n "$GITHUB_ACTIONS" ]; then
  CI_MODE=true
  echo "CI mode — skipping post-update build/test"
else
  CI_MODE=false
  echo "Interactive mode — will run pnpm run check after updates"
fi

git status --porcelain
```

<validation>
- Working tree must be clean.
- `CI_MODE` set for downstream phases.
</validation>

---

### Phase 2: Update npm packages

<action>
Run `pnpm run update` — the two-pass taze pipeline + pnpm install.
</action>

```bash
pnpm run update

if [ -n "$(git status --porcelain package.json pnpm-lock.yaml)" ]; then
  git add package.json pnpm-lock.yaml
  git commit -m "chore(deps): update npm dependencies

Two-pass taze update via pnpm run update."
  echo "npm dependencies updated"
else
  echo "npm dependencies already current"
fi
```

---

### Phase 3: Refresh external-tools.json checksums

<action>
Run `node scripts/update-tools.mts` to poll GitHub releases for
each pinned binary tool and recompute its per-platform sha256.
The script is idempotent — it no-ops when everything's current.
</action>

```bash
node scripts/update-tools.mts

if [ -n "$(git status --porcelain external-tools.json)" ]; then
  git add external-tools.json
  git commit -m "chore(deps): refresh external-tools.json checksums

Picked up newer pinned-binary releases via scripts/update-tools.mts."
  echo "external-tools.json refreshed"
else
  echo "external-tools.json already current"
fi
```

> Requires `gh` on PATH or `GH_TOKEN`/`GITHUB_TOKEN` env. The
> weekly-update workflow supplies the latter automatically.

---

### Phase 4: Run domain-specific sibling updaters

<action>
For each `updating-*` sibling skill present in this repo, invoke it.
Today there are none; this is the hook future updaters plug into.
</action>

Example (when an `updating-hljs-cdn` sibling exists):

```
Skill({ skill: "updating-hljs-cdn" })
```

If no siblings exist, skip to Phase 5.

---

### Phase 5: Validate

<action>
In interactive mode, run `pnpm run check`. CI mode skips this
because the workflow runs the equivalent in a separate job.
</action>

```bash
if [ "$CI_MODE" = "true" ]; then
  echo "CI mode — skipping pnpm run check (workflow runs it separately)"
else
  pnpm run check
fi
```

---

### Phase 6: Surface manual updates

<action>
Print a checklist of update targets this skill does *not* run.
The operator decides whether to act on them in a follow-up.
</action>

Manual checklist to print at the end of every run:

```
Manual updates (not run by this skill):

- [ ] highlight.js CDN pin in src/generate.mts. Pinned at
      @highlightjs/cdn-assets@11.11.1 with three SRI hashes
      (CSS / JS core / TypeScript grammar). To bump:
        1. Choose new version, update the three URLs.
        2. Recompute each integrity hash:
             curl -sL <url> | openssl dgst -sha384 -binary | base64
        3. Smoke-test highlighted blocks render in dev preview.
```

---

### Phase 7: Report

<action>
Generate a summary.
</action>

```
## Update complete

| Target               | Status                  |
|----------------------|-------------------------|
| npm packages         | Updated/Up to date      |
| external-tools.json  | Refreshed/Up to date    |
| Sibling updaters     | Ran N/None present      |
| pnpm run check       | Pass/Skipped (CI mode)  |

### Commits created
- [list commit shas]

### Manual follow-ups
- highlight.js CDN pin (see Phase 6 checklist)

### Next steps
**Interactive:**
1. Review: `git log --oneline -N`
2. Push: `git push origin <branch>`

**CI:**
The weekly-update workflow opens the PR.
```

</instructions>

## Success criteria

- npm dependencies checked + bumped (or confirmed current).
- `external-tools.json` checksums checked + refreshed (or confirmed current).
- All `updating-*` sibling skills present have run.
- `pnpm run check` passes (interactive mode).
- Manual-update checklist surfaced.

## When to use

- Weekly maintenance via the `.github/workflows/weekly-update.yml` cron.
- Pre-release sweep before a meander npm publish.
- Post-CVE patch rollout.

**Safety:** Phase 5 runs `pnpm run check` before reporting success.
A failure stops the process; later phases don't run on an
already-broken tree.

**Sibling skills:** None today. Add new `updating-*` skills under
`.claude/skills/` and reference them from Phase 4 of this file.
