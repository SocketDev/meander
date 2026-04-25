# Security Tools

Shared tool detection for security scanning pipelines in the meander
walkthrough generator.

## AgentShield

Pinned as a devDependency (`ecc-agentshield` in `package.json`). The
binary lands at `node_modules/.bin/agentshield` after `pnpm install`.

Detection order:

1. `node_modules/.bin/agentshield` (the canonical local path)
2. `command -v agentshield` (if a globally-installed version is on
   PATH for some reason — unusual)

Run via:

```bash
node_modules/.bin/agentshield scan --path .claude --format terminal
```

This matches what `.github/workflows/ci.yml` runs (`$MEANDER_AGENTSHIELD_BIN
scan --path .claude --format terminal`). If the binary is missing,
install with `pnpm install` — don't `npx` or `pnpm dlx`. CLAUDE.md
forbids both.

## Zizmor

Not an npm package. Pinned via `external-tools.json` (currently
`zizmor@1.23.1`). Provisioned to `.cache/external-tools/` by the
shared CI setup composite (`.github/actions/setup-and-install`).

Detection order (mirrors the source repo's pattern):

1. `command -v zizmor` (if already on PATH, e.g. via `brew install zizmor`)
2. `.cache/external-tools/zizmor/*/zizmor` (if the CI setup composite
   has run locally too)

```bash
ZIZMOR="$(command -v zizmor 2>/dev/null)"
if [ -z "$ZIZMOR" ]; then
  ZIZMOR="$(find .cache/external-tools/zizmor -name zizmor -type f 2>/dev/null | head -1)"
fi
if [ -n "$ZIZMOR" ]; then
  "$ZIZMOR" .github/
else
  echo "zizmor not installed — install via brew or run the setup composite"
fi
```

If not available locally:

- Warn: "zizmor not installed locally — install via `brew install
  zizmor` (the SHA pin lives in `external-tools.json`)"
- Skip the zizmor phase (don't fail the pipeline)
- CI must always have zizmor available via the setup composite. If
  CI is skipping zizmor, that's a real bug — fix the setup
  composite, don't paper over.

## Socket CLI

Optional. Used only when you want a manual dependency-shape audit
beyond `pnpm audit`. Not part of the standard `security-scan`
phases.

Detection: `command -v socket`

If not available:

- Skip socket-scan steps gracefully
- Note in the report: "Socket CLI not available — dependency scan skipped"

## Dependency hygiene

Don't bypass `min-release-age=7` from `.npmrc` without explicit user
approval — the threshold is a security control. The `check-new-deps`
hook at `.claude/hooks/check-new-deps/` already blocks `pnpm add` /
`npm install` of an unvetted package; let it do its job.
