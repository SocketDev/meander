# Verify Build

Shared build/test/lint validation for meander. Referenced by skills that modify code or dependencies.

## Steps

Run in order, stop on first failure:

1. `pnpm run fix` — oxfmt + oxlint --fix (mutates in place; auto-formats and auto-fixes lint).
2. `pnpm run check` — lint + type-check (read-only; what CI runs).
3. `pnpm test` — vitest against `test/**/*.test.mts`.
4. `pnpm run build` — tsc; emits `.mjs` + `.d.mts` to `dist/`. Only run if the change touches `src/` or `tsconfig.json`.

Optional, run on demand:

- `pnpm run cover` — vitest with coverage + type-coverage. Slower than `pnpm test`; reserve for pre-release verification.

## CI Mode

When `CI_MODE=true` (detected by env-check), skip this validation entirely. CI runs lint + type + test in its own matrix; re-running locally inside a CI shell is wasteful and can mask environment drift.

## On Failure

- Report which step failed with the error output verbatim.
- Don't proceed to the next pipeline phase.
- Don't try to silence the error by deleting tests or loosening lint rules — fix the underlying issue, or ask before scope-cutting.
- If the invoking pipeline tracks state in `.claude/ops/queue.yaml`, mark the run `status: failed`.
