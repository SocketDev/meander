# Environment Check

Shared prerequisite validation for skills that touch the meander
checkout. Run at the start of every skill that mutates state or
spawns long-running scans.

## Steps

1. Run `git status` to check working directory state.
2. Detect CI mode: check for `GITHUB_ACTIONS` or `CI` environment variables.
3. Verify `node_modules/` exists at the meander root (run `pnpm install` if missing).
4. Verify on a valid branch (`git branch --show-current`).
5. Confirm Node version matches `.node-version` (currently 25.9.0). Source files are `.mts`; Node 25+ runs them natively.

## Behavior

- **Clean working directory**: proceed normally.
- **Dirty working directory**: warn and continue. Most skills are read-only or open their own commits.
- **CI mode**: set `CI_MODE=true` — skills should skip interactive prompts and local-only validation.
- **Missing `node_modules`**: run `pnpm install` before proceeding. The `.npmrc` pin (`min-release-age=7`) is a security control — never bypass it.
- **Parallel sessions**: this repo may have multiple Claude sessions running against the same checkout. Don't run `git stash`, `git add -A`, `git checkout <branch>`, or `git reset --hard` in the primary checkout. Spawn a worktree if you need branch work; stage with surgical `git add <path>`.

## Queue Tracking (optional)

If the invoking skill participates in a multi-phase pipeline, it may write a run entry to `.claude/ops/queue.yaml` with:

- `id`: `{pipeline}-{YYYY-MM-DD}-{NNN}`
- `pipeline`: the invoking skill name
- `status`: `in-progress`
- `started`: current UTC timestamp
- `current_phase`: `env-check`
- `completed_phases`: `[]`

Skip the queue entry for one-shot skills.
