---
name: quality-scan
description: Read-only quality sweep for meander. Cleans junk, runs `pnpm run check`, spawns agents for critical/logic/workflow/security/docs scans, returns a prioritized report. Use before releases.
user-invocable: true
allowed-tools: Task, Skill, Bash, Read, Grep, Glob
---

# quality-scan

<task>
Perform a read-only quality sweep over the meander codebase. Clean repository junk first, run `pnpm run check` for structural validation, then spawn general-purpose agents to scan for critical bugs, logic errors, workflow issues, GitHub Actions security findings, and documentation drift. Aggregate findings, deduplicate, and produce a prioritized report.
</task>

<constraints>
- Read-only analysis. Don't fix issues during the scan.
- Run all enabled scans before reporting.
- Findings are prioritized Critical > High > Medium > Low.
- Every finding must include a `file:line` reference and a suggested fix.
- Don't bypass `min-release-age=7` (`.npmrc`) if a scan suggests a dependency bump.
- Parallel-session safety: don't `git stash`, `git add -A` / `.`, `git checkout <branch>`, or `git reset --hard` in the primary checkout. Stage with surgical `git add <path>`.
</constraints>

<instructions>

## Process

### Phase 1: Validate environment

Follow `_shared/env-check.md`. Run `git status` (warn but continue if dirty). Confirm a valid branch and that `node_modules/` exists. The pinned Node version (currently 25.9.0) is in `.node-version`.

---

### Phase 2: Update dependencies

Run `pnpm run update` for the meander checkout. The script honors the 7-day maturity period from `.config/taze.config.mts` and the `min-release-age=7` setting in `.npmrc` — don't add flags that bypass them. Report the number of packages updated. Continue with the scan even if the update step fails.

---

### Phase 3: Repository cleanup

Clean junk files before scanning:

1. **SCREAMING_TEXT.md files** (all-caps `.md` files) NOT inside `.claude/` or `docs/`, and NOT named `README.md`, `LICENSE`, or `SECURITY.md`.
2. **Misplaced test files** (`.test.mts` outside `test/`). Meander's tests live in `test/**/*.test.mts`; anything matching the pattern outside that root is misplaced.
3. **Temp files** (`*.tmp`, `*.temp`, `.DS_Store`, `Thumbs.db`, `*~`, `*.swp`, `*.swo`, `*.bak`).
4. **Stray log files** (`*.log` outside `logs/` or `dist/`).

For each file: show the path, explain why it's junk, get user confirmation before deleting. Use `git rm <path>` if tracked, `rm <path>` if untracked. Don't sweep with `git add -A` / `git rm -r`.

---

### Phase 4: Structural validation

Run `pnpm run check` (lint + type-check; what CI runs). Report errors as Critical findings; oxlint warnings are Low findings. Continue with the remaining scans regardless of the result.

---

### Phase 5: Determine scan scope

Ask the user which scan types to run. Default is all of them.

**Scan types:**

1. **critical** — crashes, prototype-pollution risk, resource leaks, data corruption, unhandled promise rejections.
2. **logic** — algorithm errors, edge cases, type guards, off-by-one, malformed-input handling, classifier predicate bugs (`src/classifiers.mts`).
3. **workflow** — `scripts/`, `package.json`, `.github/workflows/`, `.git-hooks/`, cross-platform compatibility, CLAUDE.md convention drift.
4. **security** — GitHub Actions workflow security via zizmor (delegate to the existing `security-scan` skill if scope is broader than this scan needs).
5. **documentation** — `README.md`, `docs/contributing.md`, CLAUDE.md accuracy against the actual code in `src/` and `scripts/`.

There's no separate `cache` scan in meander — content caching lives in `src/crypto.mts` (AES-256-GCM at-rest encryption) and is covered by the critical + logic scans.

---

### Phase 6: Execute scans

For each enabled scan type, spawn a `general-purpose` subagent via the Task tool. Load the agent prompt template from `reference.md`, customize for the meander context, and capture the findings.

Run scans sequentially in priority order: critical → logic → workflow → security → documentation.

Each finding must include: file path with line number, issue description, severity, code pattern, trigger, suggested fix, and impact.

---

### Phase 7: Aggregate findings

Collect all findings. Deduplicate (same `file:line` and same issue across scans, keeping the highest-priority scan's version). Sort by severity descending, then scan-type priority, then alphabetical by file path.

---

### Phase 8: Generate report

Generate a structured report using the "Report Template" section in `reference.md`. The report includes: scan metadata, dependency-update status, structural-validation results, findings grouped by severity, scan coverage, and prioritized recommendations.

Display the report to console. Optionally save it to a path the user picks (meander has no `reports/` convention — ask before writing one).

---

### Phase 9: Complete

<completion_signal>
```xml
<promise>QUALITY_SCAN_COMPLETE</promise>
```
</completion_signal>

Report final metrics: dependency-update count, structural-validation results, cleanup count, scans completed, total findings by severity, files scanned, and scan duration. See `reference.md` section "Completion Summary" for the template.

</instructions>

## Success criteria

- `<promise>QUALITY_SCAN_COMPLETE</promise>` emitted.
- All enabled scans completed without errors.
- Findings prioritized Critical > Low.
- Every finding has `file:line` and a suggested fix.
- Report includes statistics and coverage.
- Duplicate findings removed.

## Scan types

See `reference.md` for the per-scan agent prompt templates:

- **critical-scan** — null/undefined access, unhandled promise rejections, race conditions, resource leaks, prototype-pollution gaps.
- **logic-scan** — off-by-one, type guards, edge cases, classifier-predicate correctness, parser correctness in `src/generate.mts`.
- **workflow-scan** — `scripts/`, `package.json`, git hooks, `.github/workflows/`.
- **security-scan** — GitHub Actions workflow security (zizmor). For a full security pass also run the dedicated `security-scan` skill (combined AgentShield + zizmor).
- **documentation-scan** — README accuracy, CLAUDE.md drift, outdated examples in `docs/`.
