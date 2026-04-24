# CLAUDE.md

🚨 **MANDATORY**: Act as principal-level engineer with deep expertise in TypeScript, Node.js, static-site generation, and CLI design.

## USER CONTEXT

- Identify users by git credentials; use their actual name, never "the user"
- Use "you/your" when speaking directly; use names when referencing contributions

## 🚨 PARALLEL CLAUDE SESSIONS — WORKTREE REQUIRED

**This repo may have multiple Claude sessions running concurrently against the same checkout, against parallel git worktrees, or against sibling clones.** Several common git operations are hostile to that and silently destroy or hijack the other session's work.

- **FORBIDDEN in the primary checkout** (the one another Claude may be editing):
  - `git stash` — shared stash store; another session can `pop` yours.
  - `git add -A` / `git add .` — sweeps files belonging to other sessions.
  - `git checkout <branch>` / `git switch <branch>` — yanks the working tree out from under another session.
  - `git reset --hard` against a non-HEAD ref — discards another session's commits.
- **REQUIRED for branch work**: spawn a worktree instead of switching branches in place. Each worktree has its own HEAD, so branch operations inside it are safe.

  ```bash
  # From the primary checkout — does NOT touch the working tree here.
  git worktree add -b <task-branch> ../<repo>-<task> main
  cd ../<repo>-<task>
  # edit, commit, push from here; the primary checkout is untouched.
  cd -
  git worktree remove ../<repo>-<task>
  ```

- **REQUIRED for staging**: surgical `git add <specific-file> [<file>…]` with explicit paths. Never `-A` / `.`.
- **If you need a quick WIP save**: commit on a new branch from inside a worktree, not a stash.

The umbrella rule: never run a git command that mutates state belonging to a path other than the file you just edited.

## 📚 SHARED STANDARDS

- Commits: [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) `<type>(<scope>): <description>` — NO AI attribution
- 🚨 NEVER write a real customer or company name into any commit, PR, issue, GitHub comment, or release note. When about to write any name, stop and ask: "is this a real company?" If yes, replace it with `Acme Inc` (or drop the reference entirely). No enumerated denylist exists anywhere — a denylist is itself a leak. Recognition is done at write time, every time. The `.claude/hooks/public-surface-reminder` hook re-prints this rule on every public-surface `git`/`gh` command as a priming nudge; the rule still applies when the hook is not installed.
- NEVER reference issue-tracker IDs (e.g. `SOC-123`, `ENG-456`, `ASK-789`, Linear URLs, Sentry URLs) in code, code comments, or PR titles/descriptions/review comments. Tracking lives in the tracker; keep the codebase and PR history tool-agnostic.
- Scripts: `pnpm run foo --flag` (not `foo:bar`). Add tools as pinned devDependencies first.
- After `package.json` edits: `pnpm install`
- Backward Compatibility: 🚨 FORBIDDEN to maintain — actively remove when encountered
- 🚨 NEVER use `npx`, `pnpm dlx`, or `yarn dlx` — use `pnpm exec <package>` or `pnpm run <script>` # zizmor: documentation-prohibition
- **minimumReleaseAge**: the repo's `.npmrc` sets `min-release-age=7`. NEVER shorten or bypass without asking — the age threshold is a security control.

## Code Style

- Default to NO comments. Only when the WHY is non-obvious to a senior engineer.
- NEVER leave `TODO`, `FIXME`, `XXX`, shims, stubs, or placeholder code — finish 100%. If the task is too large for a single pass, inform the user and ask before cutting scope; don't silently reduce scope, and don't land half-work with a promise to fix it later.
- ❌ FORBIDDEN `any`; use `unknown` or specific types.
- Type imports: always `import type` (separate statements, never inline `type` in value imports).
- Prefer `undefined` over `null` except for `__proto__: null` or external API requirements.
- ALWAYS use `{ __proto__: null, ... }` for config/return/internal-state objects. Prevents prototype pollution and accidental inheritance.
- This repo has no HTTP dep of its own. If a feature needs one, propose the addition first (don't silently introduce `fetch()` or a new client).
- File existence: ALWAYS `existsSync` from `node:fs`. NEVER `fs.access`, `fs.stat`-for-existence, or an async `fileExists` wrapper.
- `fs` cherry-pick: `import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs"`. `path`/`os`/`url`/`crypto` use default imports (`import path from "node:path"`). Exception: `fileURLToPath` is cherry-picked from `node:url`.
- ALWAYS use the Edit tool for code modifications, NEVER sed/awk.

### `use strict`

- `.mts` / `.mjs` are ES modules — **always strict, never add `"use strict"`** (it's an error in strict ESM).
- `assets/**/*.js` (shipped client-side scripts) are **classic scripts** injected into HTML `<script>` tags without `type="module"` — they **MUST** begin with `"use strict";` at the top of the IIFE. Check existing assets (`sref.js`, `comment-client.js`, etc.) for the pattern.

### Promise.race in Loops

**NEVER re-race the same pool of promises across loop iterations.** Each call to `Promise.race([A, B, ...])` attaches fresh `.then` handlers to every arm; a promise that survives N iterations accumulates N handler sets. See [nodejs/node#17469](https://github.com/nodejs/node/issues/17469).

- **Safe**: `Promise.race([fresh1, fresh2])` where both arms are created per call (e.g. timeout wrappers).
- **Leaky**: `Promise.race(pool)` inside a loop where `pool` persists across iterations (the classic concurrency-limiter bug).
- **Fix**: single-waiter signal — each task's `.then` resolves a one-shot `promiseWithResolvers` that the loop awaits, then replaces. No persistent pool, nothing to stack.

## Token Hygiene — Non-Negotiable

🚨 **Never** emit the raw value of any secret to any tool output, commit message, comment, or assistant response. A `PreToolUse` hook at `.claude/hooks/token-hygiene/` enforces this programmatically — commands that would leak token values are refused before the tool runs.

**The hook blocks (exit code 2):**

1. Literal token shapes pasted into a command: Val Town (`vtwn_`), GitHub (`ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`/`github_pat_`), GitLab (`glpat-`), AWS (`AKIA…`), Slack (`xoxb-`/`xoxa-`/…), Google (`AIza…`), OpenAI/Anthropic-shape `sk-…`, three-segment JWTs (`eyJ…`), and others.
2. `env` / `printenv` / `export -p` / `set` with no redaction pipeline.
3. `cat` / `head` / `tail` / `less` / `more` / `bat` of `.env*` files without a redactor.
4. `curl -H "Authorization: ..."` when the response body goes to unfiltered stdout. Allowed when redirected to a file / `/dev/null` or piped to `jq`/`grep`/`head`/`tail`/`wc`/`cut`/`awk`/`python3 -m json.tool`.
5. Commands referencing a sensitive env var name (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*SIGNING_KEY*`, `*PRIVATE_KEY*`, `*AUTH*`, `*CREDENTIAL*`) that write to stdout without a redaction step — unless it's a plain `git`/`pnpm`/`npm`/`node`/`tsc`/`oxfmt`/`oxlint` invocation that only surfaces names.

**If the hook blocks a command**, stderr explains why and suggests a fix. Rewrite the command; don't bypass the hook.

**Behavioral rules** (things the hook can't catch):

- When citing an API response, redact `token` / `jwt` / `access_token` / `refresh_token` / `api_key` / `secret` / `password` / `authorization` fields to `<redacted>` before including in your reply.
- When displaying `.env.local` (or similar), show **key names only** — never values.
- If a user pastes a secret into chat, treat the session copy as compromised and ask them to rotate. Never re-echo it.
- Prefer reading env values into subprocesses via `{ env: { ... } }` spawn options over `export FOO=bar && ...` chains, so the value never appears in the Bash tool's command string.

---

## EMOJI & OUTPUT STYLE

Terminal symbols: ✓ (green), ✗ (red), ⚠ (yellow), ℹ (blue), → (cyan). Color the icon only. Avoid emoji overload.

---

## 🏗️ MEANDER-SPECIFIC

### Architecture

Walkthrough generator + live comment system. Scans source files for multiline `/* ... */` comments, pairs each with the following code block, emits HTML pages per walkthrough part, and serves a Hono-based comment backend on Val Town.

- `src/cli.mts` — CLI dispatcher (`generate`, `serve`, `publish`, `deploy-val`)
- `src/generate.mts` — HTML emission, schema, PURL + annotation rendering
- `src/serve.mts` — local HTTP preview server (used by `pnpm dev`)
- `src/classifiers.mts` — inline `<code>` shape predicates (`isPurl`, `isEmail`, `isUrl`, `isScopedPackage`)
- `src/crypto.mts` — AES-256-GCM key derivation + encryption for at-rest content
- `src/publish.mts` — encrypt + upload generated HTML to Val Town blob storage
- `src/deploy-val.mts` — one-shot Val Town val deploy
- `assets/` — client-side JS (classic scripts, `"use strict"` at top of IIFE), logos, favicon, meander.css
- `assets/val/` — the Hono HTTP handler deployed to Val Town
- `scripts/` — development automation (lint, fix, check, update, clean, dev, test, cover)
- `test/` — vitest tests; `test/fixtures/test-docs/` is the reference fixture used by `pnpm dev` + CI smoke

### Commands

- **Dev preview**: `pnpm dev` — generates `test/fixtures/test-docs/pages/` and serves it at http://127.0.0.1:8080/
- **Build**: `pnpm build` (tsc; emits `.mjs` + `.d.mts` to `dist/`)
- **Test**: `pnpm test` (vitest against `test/**/*.test.mts`)
- **Coverage**: `pnpm cover` (vitest --coverage + type-coverage)
- **Lint**: `pnpm lint` (oxlint)
- **Fix**: `pnpm fix` (oxfmt + oxlint --fix — mutates in place)
- **Check-all**: `pnpm check` (lint + type-check; what CI runs)
- **Clean**: `pnpm clean` (safeDelete of `dist/`, `coverage/`, fixture emit dirs)
- **Update deps**: `pnpm update` (taze with 7-day maturity period + reinstall)

### Configuration files

| File                         | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `tsconfig.json`              | NodeNext + `.mts` source + rewrite imports to `.mjs`       |
| `.oxlintrc.json`             | Fleet-wide oxlint rules                                    |
| `.config/taze.config.mts`    | Dep-update policy (`maturityPeriod: 7`, `mode: 'latest'`)  |
| `.npmrc`                     | `ignore-scripts=true`, `min-release-age=7`                 |
| `pnpm-workspace.yaml`        | `.claude/hooks/*` registered as workspace packages         |
| `.node-version`              | Pinned node version (25.9.0)                               |

### Node + TypeScript

- Source files are `.mts`. Node 25+ runs them natively — no flag needed (the pinned version lives in `.node-version`). The `scripts/` runners just shell out to `node scripts/foo.mts`.
- `tsconfig.json` enables `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` — imports say `.mts`, tsc rewrites to `.mjs` at build time so the same source runs under Node (native) OR under the dist'd output.
- `erasableSyntaxOnly` is enforced: no runtime-only TS syntax (no `enum`, no namespaces, etc.).
- `noUncheckedIndexedAccess` is enforced: `arr[i]` has type `T | undefined`.

### File structure rules

- TypeScript sources in `src/` are `.mts` — never `.ts`. Never re-add `.ts` by mistake.
- NEVER add `"use strict"` to `.mts` / `.mjs` files (ES modules are always strict).
- DO add `"use strict";` at the top of the IIFE in `assets/**/*.js` (classic scripts shipped to the browser).
- Type imports: always `import type` (separate statements, never inline `type` in value imports).

### Consumer contract

Meander is published to npm as `@divmain/meander`. Consumers place `meander.config.json` at the root of their project and call `meander generate`. The config schema is defined via TypeBox in `src/config.mts` (`MeanderConfigSchema` + sub-schemas for parts, docs, favicon, comments, theme, styles). **Breaking config-schema changes need a major version bump** and a migration note in the release.

- `slug`, `title`, `parts[]` — required
- `documents[]` — optional tabbed Markdown reference docs
- `comments: false` — opt out of the inlined comment client
- `favicon` — object (per-size asset overrides, `themeColor` meta), or `false` to skip favicon emission entirely

### Assets pipeline

- Logos: authored as `assets/logo/logo-black.svg` (master silhouette). Color + bezel variants are regenerated from the master via the scripts in `scripts/` when the master changes.
- Favicon: generated from `assets/favicon/favicon.svg` (the brand mark) at 16/32/48/180 + `.ico` bundle. Not auto-rebuilt — regenerate manually when the mark changes.
- SVGs: run `pnpm optimize-svgs` after editing to ensure svgo passes (removes Inkscape metadata, preserves `xmlns` / `viewBox` / `<title>` for a11y).

### hljs CDN

- `src/generate.mts` emits `<script>` + `<link>` tags for the pinned @highlightjs/cdn-assets@11.11.1. Every tag carries an SRI `integrity="sha384-..."` computed from the pinned bytes. If the pin bumps, recompute:
  ```bash
  curl -sL <url> | openssl dgst -sha384 -binary | base64
  ```
- TypeScript grammar is loaded alongside core hljs so `@example` fenced `typescript` blocks highlight correctly.

### Agents & Hooks

- `.claude/hooks/check-new-deps/` — blocks `pnpm add` / `npm install` of an unvetted package
- `.claude/hooks/token-hygiene/` — blocks commands that would leak secrets
- `.claude/hooks/public-surface-reminder/` — nudge-not-block reminder before `git commit`/`git push`/`gh pr` that customer names and tracker IDs must stay out of public surface

### Testing & CI

- **No unit-test suite yet** — when one is added, prefer `node:test` (matches hooks' test files) to keep the runtime-dep footprint minimal.
- **CI**: GitHub Actions at `.github/workflows/` — keep action refs pinned to full SHAs, not tags.

### Context & edit safety

- After 10+ messages: re-read files before editing.
- Before/after every edit: re-read to confirm.
- Tool results over 50K chars are silently truncated — narrow scope and re-run if sparse.
- Tasks touching >5 files: use sub-agents with worktree isolation.

### Judgment & completion

- If the user's request is based on a misconception, say so before executing.
- If you spot a bug adjacent to what was asked, flag it: "I also noticed X — want me to fix it?"
- Fix warnings when you find them (lint, type-check, build, runtime) — don't leave them for later.
- **Default to perfectionist mindset**: pick the maximally correct option; no shortcuts. If pragmatism is the right call, the user will ask.
- Before calling done: present two views — perfectionist reject vs. pragmatist ship — and let the user decide. If the user gives no signal, default to perfectionist.
- If a fix fails twice: stop, re-read top-down, state where the mental model was wrong, try something fundamentally different.
- NEVER claim done at 80% — finish 100% before reporting. Fix forward, don't revert; reverting requires explicit user approval. After EVERY code change: build, test, verify, commit — one atomic unit.
</content>
