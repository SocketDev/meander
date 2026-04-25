Run the `/quality-scan` skill and fix the issues it surfaces. Repeat until zero findings remain or 5 iterations complete.

Interactive only — this command makes code changes and commits. Don't use it as an automated pipeline gate.

## Process

1. Run the `/quality-scan` skill (all scan types).
2. If findings exist, spawn the `refactor-cleaner` agent (see `agents/refactor-cleaner.md`) to fix them, grouped by category.
3. Run verify-build (see `_shared/verify-build.md`) after fixes — `pnpm run fix`, then `pnpm run check`, then `pnpm test`.
4. Run `/quality-scan` again.
5. Repeat until either:
   - Zero findings (success), or
   - 5 iterations completed (stop and report).
6. Commit fixes with a Conventional Commits subject like `fix(quality): resolve scan findings (iteration N)`.

## Rules

- Fix every finding, not just the easy ones. If a finding is a false positive, document why in the commit body — don't silently skip it.
- Spawn `refactor-cleaner` with the pre-action protocol from CLAUDE.md: dead code first, then structural changes, ≤5 files per phase.
- Run tests after every fix batch to confirm nothing broke.
- Track iteration count and report progress between iterations.
- Don't bypass `min-release-age=7` (`.npmrc`) when bumping deps to satisfy a finding.
- Don't `git stash`, `git add -A` / `.`, `git checkout <branch>`, or `git reset --hard` in the primary checkout — other Claude sessions may share it. Stage with surgical `git add <path>`.
