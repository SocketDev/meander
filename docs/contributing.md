# Contributing to meander

This doc is for people working on meander itself, not consumers
using it.

## Requirements

- Node >= 20 (25+ is pinned in `.node-version`; earlier major
  versions work for building but tests assume 20+ APIs).
- pnpm 11+.

## First-time setup

```bash
pnpm install
pnpm build    # tsc emits dist/
```

## Everyday commands

| Command         | What it does                                                                  |
| --------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`      | Generate the fixture and serve it at http://127.0.0.1:8080 with file-watcher. |
| `pnpm test`     | Run the vitest suite under `test/`.                                           |
| `pnpm test:val` | Run the val's co-located `node:test` suite under `assets/val/lib/`.           |
| `pnpm cover`    | vitest + type-coverage, prints a combined summary.                            |
| `pnpm check`    | lint + type-check (what CI runs).                                             |
| `pnpm fix`      | oxfmt + oxlint --fix; mutates files in place.                                 |
| `pnpm clean`    | Remove `dist/`, `coverage/`, fixture emit dirs.                               |
| `pnpm build`    | `tsc`; emits `.mjs` + `.d.mts` to `dist/`.                                    |

## Tests

- Tests live in `test/**/*.test.mts`.
- Fixtures live in `test/fixtures/`. The reference fixture,
  `test/fixtures/test-docs/`, also powers `pnpm dev` and the
  CI smoke test.
- Config is at `.config/vitest.config.mts`. Coverage provider is
  v8; thresholds are 95% lines / statements / functions, 90%
  branches (branch coverage dips because V8 surfaces micro-
  branches in `??` / `&&` chains that only one side hits in
  practice).
- Need a scratch directory? Use
  `mkdtempSync(path.join(os.tmpdir(), '…'))` + `safeDelete`
  from `@socketsecurity/lib/fs` in `afterEach`. Never write
  into the repo tree.

### Val tests

The val (`assets/val/index.ts`) runs under Deno at Val Town.
Its pure helpers — crypto, JWT, auth-domain matching — live in
`assets/val/lib/*.ts` and have co-located `*.test.ts` files
that run under `node:test` via `pnpm test:val`. Web Crypto is
available in both Deno and Node so the helpers behave
identically; tests don't mock anything.

The val's HTTP routes (the Hono app + blob/sqlite interactions)
are not unit-tested — they're exercised end-to-end by
`meander deploy-val` against a staging val and the human
sign-in flow. If a future route changes pull logic out of the
request handler, move that logic into `lib/` too and test it
there.

## CI

- `.github/workflows/ci.yml` — lint + type-check + smoke test
  - full test suite with coverage.
- `.github/workflows/pages.yml` — builds the fixture under
  `--base-path=/meander` and deploys it to
  `https://socketdev.github.io/meander/` as a live demo.

Keep every action ref pinned to a full commit SHA, not a tag,
per the fleet security policy.

## Code style

oxfmt + oxlint enforce style. Relevant settings that aren't
obvious from looking at a diff:

- Single quotes for strings.
- No semicolons (ASI).
- Arrow parens avoided when safe (`x => x.id`).
- Trailing commas everywhere they're valid.
- Type imports as separate `import type` statements, never
  inline `type` in value imports.

Browser scripts under `assets/*.js` are a separate world:

- ES5-compatible (`var`, `function`, classic for-loops).
- Wrapped in an IIFE with `"use strict";` at the top.
- DOMContentLoaded guard pattern:
  ```javascript
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
  ```

## Architecture tour

- `src/cli.mts` — argv parser + command dispatcher.
- `src/generate.mts` — HTML emission + annotation pipeline.
- `src/config.mts` — single-source schema (TypeBox) + loader.
- `src/serve.mts` — local preview server.
- `src/publish.mts` — encrypt + upload to Val Town.
- `src/deploy-val.mts` — one-shot val deploy.
- `src/crypto.mts` — AES-256-GCM + PBKDF2 helpers.
- `src/classifiers.mts` — inline `<code>` shape predicates.
- `src/minify.mts`, `src/security.mts`, `src/prose-polishers.mts`,
  `src/render-mermaid.mts`, `src/url-rewrite.mts` — emit-time
  passes applied by `generate`.
- `assets/val/index.ts` — the deployed Hono handler.

## Submitting changes

- Conventional Commits format: `<type>(<scope>): <description>`.
- No AI attribution in commit messages.
- No customer names or issue-tracker IDs (`SOC-123`, Linear
  URLs, etc.) in code, commits, or PRs.
- Breaking config-schema changes need a major version bump and
  a migration note.
