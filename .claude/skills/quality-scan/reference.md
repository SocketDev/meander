# quality-scan Reference Documentation

Rule catalog, agent prompts, severity guide, and report templates
for the `quality-scan` skill. SKILL.md covers the phased workflow;
this file covers what each scan looks for and how findings are
formatted.

## Table of Contents

1. [Core principles (KISS)](#kiss)
2. [Critical scan agent](#critical-scan)
3. [Logic scan agent](#logic-scan)
4. [Workflow scan agent](#workflow-scan)
5. [Security scan agent (zizmor)](#security-scan)
6. [Documentation scan agent](#documentation-scan)
7. [Severity levels](#severity-levels)
8. [Report template](#report-template)
9. [Completion summary](#completion-summary)
10. [Edge cases](#edge-cases)

---

<a id="kiss"></a>
## 1. Core principles

### KISS (Keep It Simple, Stupid)

Always prioritize simplicity — the simpler the code, the fewer
bugs it will have.

Common violations to flag:

- **Over-abstraction** — utilities, helpers, or wrappers for a
  one-time operation.
- **Premature optimization** — caching, memoization, or
  performance tricks before profiling.
- **Unnecessary indirection** — multiple function-call layers when
  direct code would be clearer.
- **Complex path construction** — manual path building when a
  helper returns the path you need.
- **Feature creep** — "nice to have" additions that complicate the
  core logic.

Examples:

**Bad — ignoring a return value and reconstructing a path:**

```typescript
await downloadAsset({ asset, downloadDir })
const downloadedPath = path.join(downloadDir, asset)  // assumes structure
```

**Good — use the return value:**

```typescript
const downloadedPath = await downloadAsset({ asset, downloadDir })
```

If a function returns what you need, use it. Don't reconstruct or
assume.

---

<a id="critical-scan"></a>
## 2. Critical scan agent

**Mission**: identify critical bugs that could cause crashes, data
corruption, or security vulnerabilities.

**Scan targets**: all `.mts` files under `src/` and `scripts/`.

**Prompt template** (paste into a `general-purpose` subagent):

```
Your task is to perform a critical-bug scan on the meander codebase. Identify bugs that could cause crashes, data corruption, or security vulnerabilities.

<context>
meander is a TypeScript walkthrough generator (`@divmain/meander`). It scans source files for multiline `/* ... */` comments, pairs each with the following code block, emits HTML pages per walkthrough part, and serves a Hono-based comment backend on Val Town.

Source layout:
- src/cli.mts — CLI dispatcher (`generate`, `serve`, `publish`, `deploy-val`)
- src/generate.mts — HTML emission, schema, PURL + annotation rendering
- src/serve.mts — local HTTP preview server
- src/classifiers.mts — inline `<code>` shape predicates (`isPurl`, `isEmail`, `isUrl`, `isScopedPackage`)
- src/crypto.mts — AES-256-GCM key derivation + encryption for at-rest content
- src/publish.mts — encrypt + upload generated HTML to Val Town blob storage
- src/deploy-val.mts — one-shot Val Town val deploy
- src/minify.mts — dynamic-import esbuild for JS/CSS minify (degrades gracefully)
- assets/val/ — Hono HTTP handler deployed to Val Town
- scripts/*.mts — development automation (lint, fix, check, update, clean, dev, test, cover)

Conventions from CLAUDE.md to enforce:
- `.mts` source files (never `.ts`)
- No `any`; use `unknown` or specific types
- Prefer `undefined` over `null` (except `__proto__: null` or external API requirements)
- `{ __proto__: null, ... }` for config / return / internal-state objects
- File existence: `existsSync` from `node:fs` (never `fs.access` or async wrappers)
- `fs` cherry-pick (`existsSync`, `promises as fs`, `readFileSync`, `writeFileSync`); `path` / `os` / `url` / `crypto` default-import; `fileURLToPath` cherry-picked from `node:url`
- Type imports: always `import type` as separate statements
- `.mts` / `.mjs` ES modules: never add `"use strict"` (it's a syntax error)
- `assets/**/*.js` classic scripts: must begin with `"use strict";` at the top of the IIFE
- No `npx`, `pnpm dlx`, `yarn dlx` — `pnpm exec <pkg>` or `pnpm run <script>`
- `Promise.race` in loops: never re-race the same persistent pool across iterations
</context>

<instructions>
Scan all `.mts` files under `src/` and `scripts/` for these critical-bug patterns:

<pattern name="null_undefined_access">
- Property access without optional chaining when the value might be null/undefined
- Array access without length validation (`arr[0]`, `arr[arr.length-1]`) — note `noUncheckedIndexedAccess` is enabled, so `arr[i]` has type `T | undefined` and must be guarded
- `JSON.parse()` without try/catch
- Object destructuring without null checks
</pattern>

<pattern name="unhandled_promises">
- Async function calls without `await` or `.catch()`
- `.then()` chains without `.catch()`
- Fire-and-forget promises that may reject
- Missing error handling inside `async` / `await` blocks
</pattern>

<pattern name="race_conditions">
- Concurrent FS operations without coordination (especially around `dist/` emit and the comment-store paths in `assets/val/`)
- Parallel cache reads/writes without synchronization
- Check-then-act patterns without atomic operations
- Shared-state mutation inside `Promise.all`
- `Promise.race` in a loop where the racing pool persists across iterations (this is a documented Node leak — see CLAUDE.md "Promise.race in Loops")
</pattern>

<pattern name="type_coercion">
- `==` instead of `===`
- Implicit type conversions that fail silently
- Truthy/falsy checks where explicit `!= null` is required
- `typeof x === 'object'` true for null and arrays — use `Array.isArray()` plus explicit null check
</pattern>

<pattern name="resource_leaks">
- File handles opened but not closed (missing `.close()` or `using`)
- Timers created but not cleared (`setTimeout` / `setInterval`)
- Event listeners added but not removed
- Memory accumulation in long-running processes (the dev preview server keeps watching)
</pattern>

<pattern name="prototype_pollution">
**CLAUDE.md rule**: config / return / internal-state objects MUST use `{ __proto__: null, ... }` to prevent prototype-chain inheritance.

Flag any:
- Plain `{}` literal used to accumulate user-controlled keys (especially anything walked from `meander.config.json`, walkthrough sources, or comment payloads in `assets/val/`)
- `Object.create(null)` used inconsistently with the `__proto__: null` style elsewhere — pick one and stick with it
- Spread of untrusted input directly into an inherited-prototype object
</pattern>

<pattern name="forbidden_any">
**CLAUDE.md rule**: `any` is forbidden. Use `unknown` or a specific type.

Flag every `: any` annotation, every `as any` assertion, and every implicit `any` from a missing return type.
</pattern>

<pattern name="forbidden_null">
**CLAUDE.md rule**: prefer `undefined` over `null` except `__proto__: null` or external API requirements (Val Town SDK, marked, hljs CDN responses).

Flag returning `null` from internal helpers, defaulting parameters to `null`, or `null` in TypeBox `Type.Union([..., Type.Null()])` where `Type.Optional(...)` would be correct.
</pattern>

<pattern name="forbidden_fs_access">
**CLAUDE.md rule**: file existence checks use `existsSync` from `node:fs`. Never `fs.access` (sync or async), `fs.stat` for existence, or an async `fileExists` wrapper.

Flag any of those patterns and recommend `existsSync(path)` directly.
</pattern>

<pattern name="forbidden_use_strict">
- `.mts` / `.mjs` files containing `"use strict";` — flag as critical (syntax error in strict ESM)
- `assets/**/*.js` files MISSING `"use strict";` at the top of the IIFE — flag as critical (drops strict mode for shipped browser scripts)
</pattern>

<pattern name="json_parse_without_guard">
External input parsing — config files, walkthrough source headers, network responses from the Val Town backend, blob downloads in `src/publish.mts` — must be guarded:
```typescript
let parsed: Foo
try {
  parsed = JSON.parse(text)
} catch (err) {
  throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`)
}
```
Flag any `JSON.parse` without surrounding try/catch.
</pattern>

For each bug, think through:
1. Can this actually crash in production?
2. What input would trigger it?
3. Does surrounding code already handle it?
</instructions>

<output_format>
For each finding, report:

File: src/path/to/file.mts:lineNumber
Issue: [One-line description]
Severity: Critical
Pattern: [Problematic code snippet]
Trigger: [Input/condition that causes the bug]
Fix: [Specific change to fix]
Impact: [What happens when triggered]

Example:
File: src/publish.mts:142
Issue: Unhandled rejection in upload chain
Severity: Critical
Pattern: `await client.upload(blob)` without surrounding try/catch
Trigger: Val Town blob API returns a 500 or the auth token expires
Fix: Wrap in try/catch and surface a structured error: `try { await client.upload(blob) } catch (err) { throw new Error(\`Val Town upload failed for \${blob.key}: \${(err as Error).message}\`) }`
Impact: Uncaught rejection crashes the publish CLI mid-deploy, leaving partial state in Val Town storage
</output_format>

<quality_guidelines>
- Report actual bugs, not style issues.
- Verify the bug isn't already handled by surrounding code.
- Focus on bugs that affect reliability and correctness.
- For TypeScript: focus on promise handling, type guards, external-input validation.
- Skip false positives — TypeScript narrowing is sufficient in many cases.
- Scan `src/`, `scripts/`, and `assets/val/` systematically.
</quality_guidelines>

Scan systematically and report all critical bugs. If none, state that explicitly.
```

---

<a id="logic-scan"></a>
## 3. Logic scan agent

**Mission**: detect logic errors in algorithms, data processing, and business logic that produce incorrect output or behavior.

**Scan targets**: all source files (`src/**/*.mts`, `scripts/**/*.mts`, `assets/val/**/*.ts`).

**Prompt template:**

```
Your task is to detect logic errors in the meander codebase that could produce incorrect output or behavior. Focus on algorithm correctness, edge-case handling, and data validation.

<context>
Areas with high logic-error density:
- src/generate.mts — pairs `/* */` comments with the following code block. Off-by-one or empty-block edge cases here mean missing or duplicated walkthrough sections.
- src/classifiers.mts — inline `<code>` shape predicates (`isPurl`, `isEmail`, `isUrl`, `isScopedPackage`). False positives in classifiers cause wrong rendering.
- src/url-rewrite.mts — URL rewriting on emit; edge cases around protocol-relative, fragment-only, and query-only URLs are typical bug spots.
- src/minify.mts — dynamic esbuild import; if the import fails, the file should pass the source through unmodified.
- src/shamir.mts / src/db-key.mts / src/blob-key.mts — secret-sharing and key derivation. Bugs here corrupt at-rest data permanently.
- src/config.mts — TypeBox schema for `meander.config.json`. Schema drift vs. consumer expectation breaks every consumer.
- assets/val/ — Hono backend deployed to Val Town. Comment store, JWT session validation, magic-code auth flow.
</context>

<instructions>
Analyze code for these patterns:

<pattern name="off_by_one">
- Loop bounds (`i <= arr.length` should be `i < arr.length`)
- Slice operations (`arr.slice(0, len-1)` when full array is needed)
- String indexing missing first or last character
- `lastIndexOf()` checks that miss position 0
- Comment-pairing in `src/generate.mts`: paired comment is the *one immediately preceding* the code block — verify the index math when comments are stacked
</pattern>

<pattern name="type_guards">
- `if (obj)` allows 0, "", false — use `obj != null` or explicit checks
- `if (arr.length)` crashes if `arr` is undefined — check existence first (and `noUncheckedIndexedAccess` makes element access return `T | undefined`)
- `typeof x === 'object'` true for null and arrays — use `Array.isArray()` plus explicit null check
- Missing validation before destructuring or property access
</pattern>

<pattern name="edge_cases">
- `str.split('.')[0]` when delimiter might not exist
- `parseInt(str)` without `Number.isNaN(...)` validation
- `lastIndexOf('@')` returns -1 if not found, but 0 is valid for scoped packages (`@scope/name`)
- Empty strings, empty arrays, single-element arrays
- Malformed input handling (missing try/catch, no fallback)
- Classifier predicates returning the wrong shape: an `@scope/name` is a scoped package, not an email
</pattern>

<pattern name="algorithm_correctness">
- Comment / code pairing in `src/generate.mts`: the comment must be the immediately-preceding multiline `/* */`, not any earlier one. Off-by-one in this pairing produces silent walkthrough corruption.
- URL rewriting in `src/url-rewrite.mts`: protocol-relative, fragment-only (`#foo`), query-only (`?bar`), and bare-path URLs must each round-trip correctly.
- TypeBox schema validation in `src/config.mts`: missing required fields, accepting extra fields when `additionalProperties: false` is intended, or accepting wrong-shape `parts[]` entries.
- Sorting / deduplication in `src/generate.mts` part-emit: deterministic order is part of the consumer contract.
</pattern>

<pattern name="encoding_and_html_safety">
- HTML emission must escape `<`, `>`, `&`, `"` in any user-supplied string (titles, comment bodies, walkthrough source paths). Flag any string interpolated into the emitted HTML without an escape helper.
- URL rewriting emitting unescaped attribute values
- JSON-in-script-tag emission missing `</` escape
</pattern>

<pattern name="schema_drift">
**CLAUDE.md rule**: breaking config-schema changes need a major version bump and a migration note.

Flag changes in `src/config.mts` that:
- Add a required field
- Remove an optional field
- Change an optional field's default in a way that changes emit output
- Tighten validation on a field that accepts user input today
</pattern>

<pattern name="comments_block_finish">
**CLAUDE.md rule**: never leave `TODO`, `FIXME`, `XXX`, shims, stubs, or placeholder code.

Flag any `TODO` / `FIXME` / `XXX` markers, stub functions returning `undefined`, or branches with a "fix later" comment.
</pattern>

Before reporting, think through:
1. Does this logic error actually produce incorrect output?
2. What specific input would trigger it?
3. Is the error already handled elsewhere?
</instructions>

<output_format>
For each finding, report:

File: src/path/to/file.mts:lineNumber
Issue: [One-line description]
Severity: High | Medium
Edge Case: [Specific input that triggers]
Pattern: [Problematic code snippet]
Fix: [Corrected code]
Impact: [Incorrect output produced]

Example:
File: src/classifiers.mts:42
Issue: `isEmail` returns true for `@scope/name`
Severity: High
Edge Case: When the inline code is a scoped npm package (`@socketsecurity/lib`)
Pattern: `return /^[^@]+@[^@]+$/.test(text)`
Fix: Run `isScopedPackage(text)` first and return false if it matches
Impact: Scoped package names render as mailto links in walkthroughs
</output_format>

<quality_guidelines>
- Prioritize code handling external input (config files, walkthrough sources, comment-store payloads, Val Town responses).
- Focus on errors affecting correctness and data integrity.
- Verify logic errors aren't false alarms due to type narrowing.
- Consider real-world edge cases: malformed input, unusual formats, cross-platform paths.
</quality_guidelines>

Analyze systematically and report all logic errors. If none, state that explicitly.
```

---

<a id="workflow-scan"></a>
## 4. Workflow scan agent

**Mission**: detect issues in build scripts, CI configuration, git hooks, and developer workflows.

**Scan targets**: `scripts/`, `package.json`, `.git-hooks/*`, `.github/workflows/*`.

**Prompt template:**

```
Your task is to identify issues in meander's development workflows, build scripts, and CI configuration that could cause build failures, test flakiness, or poor developer experience.

<context>
meander is a single-package TypeScript repo (no monorepo workspaces beyond `.claude/hooks/*` registered via `pnpm-workspace.yaml`).

- Build scripts: scripts/*.mts (ESM, .mts, run natively by Node 25+)
- Package manager: pnpm (pinned in `packageManager` field of package.json)
- CI: GitHub Actions in `.github/workflows/`:
  - ci.yml — lint + type + test + AgentShield
  - pages.yml — emits the dev fixture as a GitHub Pages preview
  - provenance.yml — npm publish provenance
  - valtown.yml — deploys the Hono handler in `assets/val/` to Val Town
  - weekly-update.yml — runs `pnpm run update` weekly
- Hooks live at `.claude/hooks/{check-new-deps,token-hygiene,public-surface-reminder}/` registered as workspace packages
- Node version pinned in `.node-version` (currently 25.9.0)
</context>

<instructions>
Analyze workflow files for these issue categories:

<pattern name="scripts_cross_platform">
- Hardcoded `/` or `\` instead of `path.join` / `path.resolve`
- Platform-specific shell commands (`rm` vs `del`, `cp` vs `copy`)
- Line-ending handling (`\n` vs `\r\n` in text processing)
- Case sensitivity differences (Windows vs Linux/macOS)
- Env var syntax (`%VAR%` vs `$VAR`)
</pattern>

<pattern name="scripts_errors">
- Missing try/catch around async ops
- Non-zero exit on failure for CI detection
- Helpful error messages?
- Dependency checks before tool use

**Note**: `existsSync()` is acceptable and preferred for sync file existence (CLAUDE.md mandates it). Do not flag `existsSync()` as an issue.

**Note**: `process.exit()` is acceptable in `scripts/*.mts` — they are CLI runners, not library code.
</pattern>

<pattern name="forbidden_dlx">
**CLAUDE.md rule**: `npx`, `pnpm dlx`, `yarn dlx` are forbidden. Use `pnpm exec <pkg>` or `pnpm run <script>`.

Flag any usage of these in scripts, package.json, README, docs, hooks, or workflow yaml.
</pattern>

<pattern name="import_conventions">
**CLAUDE.md rules** for `node:` built-ins:
- `fs`: cherry-pick — `import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs"`
- `path` / `os` / `url` / `crypto`: default import — `import path from "node:path"`
- Exception: `fileURLToPath` cherry-picked from `node:url`

Flag every violation. Examples:
- `import fs from "node:fs"` (should cherry-pick)
- `import { join, resolve } from "node:path"` (should default-import path)
- `import { readFile } from "node:fs/promises"` (should use `promises as fs` from `node:fs`)
- Type imports inlined inside value imports: `import { type Foo, bar } from "..."` (should split into `import type { Foo } from "..."` plus `import { bar } from "..."`)
</pattern>

<pattern name="package_json_scripts">
**CLAUDE.md rule**: scripts use `pnpm run foo --flag`, not `foo:bar` colon-separated names.

- Script chaining: prefer `&&` over `;` when errors matter
- Cross-platform-incompatible commands (raw `grep`, `find` with non-portable flags)
- Convention compliance with CLAUDE.md
</pattern>

<pattern name="git_hooks">
- Pre-commit: runs lint/format and is fast (<10s)?
- Pre-push: runs tests to prevent broken pushes?
- False positives that block legitimate commits
- Helpful error messages on hook failure
- Hook installation documented in README

**Note**: meander ships three hooks (`check-new-deps`, `token-hygiene`, `public-surface-reminder`) registered as `pnpm` workspace packages. Treat them as code, not config — they have their own `package.json` and `index.mjs`.
</pattern>

<pattern name="ci_configuration">
- Build order (install → check → test → publish)
- Cross-platform coverage (Linux is primary; macOS/Windows are nice-to-have given meander has no native code)
- Node version matrix (the matrix should include the pinned `.node-version` entry, not floating `current` / `lts`)
- Action pinning (full SHA, not tag — see zizmor scan; meander already does this on `actions/checkout@…`)
- Workflow permissions narrowing (`contents: read` is the right default; only widen when the job pushes / releases)
- Failure notifications visible to the maintainer
- Patch / dependency-update workflows (`weekly-update.yml`) honoring `min-release-age=7` and the 7-day taze maturity period
</pattern>

<pattern name="developer_experience">
- Common errors documented with solutions in `docs/contributing.md`
- Required env vars documented (Val Town deploy needs `VALTOWN_API_TOKEN`; the publish flow uses ceremony deps in `src/ceremony-deps.mts`)
- Setup steps listed in README
</pattern>

<pattern name="security_controls">
**CLAUDE.md rule**: don't bypass `min-release-age=7` (`.npmrc`) or `maturityPeriod: 7` (`.config/taze.config.mts`).

Flag any script, workflow, or doc that suggests `--allow-prerelease`, `--no-cooldown`, deleting `.npmrc`, or running `pnpm install --ignore-min-release-age` to skip the threshold.
</pattern>

For each issue:
1. Does it actually affect developers or CI?
2. How often would it be encountered?
3. Is there a simple fix?
</instructions>

<output_format>
For each finding, report:

File: [scripts/foo.mts:line OR package.json:scripts.<name> OR .github/workflows/<file>.yml:line]
Issue: [One-line description]
Severity: Medium | Low
Impact: [Effect on developers or CI]
Pattern: [Problematic code/config]
Fix: [Specific change]

Example:
File: scripts/build.mts:23
Issue: Default-imports `path` cherry-pick style instead of CLAUDE.md convention
Severity: Low
Impact: Inconsistent style; reviewers must mentally normalize across scripts
Pattern: `import { join, resolve } from "node:path"`
Fix: `import path from "node:path"` and call `path.join(...)` / `path.resolve(...)`
</output_format>

<quality_guidelines>
- Focus on issues that cause actual build/test failures.
- Consider cross-platform scenarios.
- Verify conventions match CLAUDE.md.
- Prioritize developer-experience issues (confusing errors, missing docs).
</quality_guidelines>

Analyze workflow files systematically. If they're well-configured, state that explicitly.
```

---

<a id="security-scan"></a>
## 5. Security scan agent (zizmor)

**Mission**: scan GitHub Actions workflows for security vulnerabilities using zizmor.

**Scan targets**: all `.yml` files in `.github/workflows/`.

**Note**: meander has a dedicated `security-scan` skill that combines AgentShield + zizmor with a graded report. Prefer that skill for a full security pass. This sub-scan inside `quality-scan` is a lighter zizmor-only pass when the operator wants security findings as part of an aggregate quality report.

**Prompt template:**

```
Your task is to run zizmor on meander's GitHub Actions workflows and identify findings such as template injection, cache poisoning, unpinned actions, and other workflow security issues.

<context>
zizmor is provisioned via `external-tools.json` (currently `zizmor@1.23.1`). It lands in `.cache/external-tools/` after the shared `setup-and-install` composite runs. If unavailable locally, run `brew install zizmor` or run the setup composite — don't `pnpm dlx zizmor` (forbidden by CLAUDE.md).

meander's `.github/workflows/zizmor.yml` configuration disables the `secrets-outside-env` rule. Don't re-flag findings the upstream config has silenced.

Workflows in `.github/workflows/`:
- ci.yml, pages.yml, provenance.yml, valtown.yml, weekly-update.yml
</context>

<instructions>
1. Run zizmor on all workflow files:
   ```bash
   ZIZMOR="$(command -v zizmor 2>/dev/null)"
   if [ -z "$ZIZMOR" ]; then
     ZIZMOR="$(find .cache/external-tools/zizmor -name zizmor -type f 2>/dev/null | head -1)"
   fi
   "$ZIZMOR" .github/
   ```

2. Parse the zizmor output and identify all findings:
   - Severity (info, low, medium, high, error)
   - Vulnerability type (template-injection, cache-poisoning, unpinned-action, etc.)
   - File and line numbers
   - Audit confidence
   - Whether `--fix` is available

3. For each finding, report file:line, vulnerability type and severity, description, security impact, suggested fix (zizmor's suggestion if available), and whether auto-fix exists.

4. If zizmor reports no findings, state: "No security issues found in GitHub Actions workflows."

5. Note any suppressed findings (still shown by zizmor but marked suppressed).
</instructions>

<pattern name="template_injection">
- `info[template-injection]` / `error[template-injection]`
- Code injection via template expansion in `run:` blocks
- Unsanitized `${{ }}` in shell context
- User-controlled input (PR title, issue body, comment body) used in shell

Trusted-context fields (`github.run_id`, `github.sha`, `github.ref_name`) are flagged by default — they're safe to interpolate. Suppress per-line with `# zizmor: ignore[template-injection] trusted-field`.
</pattern>

<pattern name="cache_poisoning">
- `error[cache-poisoning]` / `warning[cache-poisoning]`
- Caching enabled in workflows that publish artifacts (e.g. `actions/setup-node` with `cache: 'npm'` in a release job)
</pattern>

<pattern name="credential_exposure">
- Secrets logged to console
- Tokens passed insecurely
- Token leakage via workflow logs
</pattern>

<pattern name="unpinned_actions">
- Tag refs (`actions/checkout@v4`) instead of full SHAs
- Reusable workflow calls (`uses: owner/repo/.github/workflows/file.yml@ref`) without SHA
- Pin via `gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq .object.sha`
</pattern>

<output_format>
For each finding:

{
  file: ".github/workflows/<name>.yml:<line>",
  issue: "<one-line description>",
  severity: "Critical | High | Medium | Low | Info",
  scanType: "security",
  pattern: "<the problematic code or config>",
  trigger: "<what triggers it>",
  fix: "<specific change>",
  impact: "<security consequence>",
  autofix: <true|false>
}

Group findings by severity (Error → High → Medium → Low → Info).
</output_format>

<quality_guidelines>
- Only report actual zizmor findings; don't invent them.
- Include all details from zizmor output.
- Note audit confidence per finding.
- Indicate if `--fix` is available.
- If no findings, state explicitly.
- Report suppressed findings separately.
</quality_guidelines>
```

---

<a id="documentation-scan"></a>
## 6. Documentation scan agent

**Mission**: verify documentation accuracy by checking README files, code comments, and examples against the actual codebase.

**Scan targets**: all `README.md` files, `docs/*.md`, CLAUDE.md, and inline code examples.

**Prompt template:**

```
Your task is to verify documentation accuracy across meander's README, `docs/`, and CLAUDE.md by comparing documented behavior, examples, commands, and API descriptions against the actual codebase implementation.

<context>
Documentation accuracy is critical for:
- Consumer adoption (meander is published as `@divmain/meander` to npm)
- Preventing confusion from outdated examples
- Maintaining trust in the project
- Reducing support burden

Files to verify:
- README.md — top-level
- docs/contributing.md — test layout, coverage thresholds, CI pinning rules
- CLAUDE.md — project conventions (must stay in sync with actual scripts, hooks, settings)
- src/cli.mts — match `meander generate` / `serve` / `publish` / `deploy-val` flag documentation
- src/config.mts — TypeBox schema must match documented `meander.config.json` shape

Common issues:
- Package name drift vs. `package.json` (`@divmain/meander`)
- Command examples with wrong flags
- API examples for non-existent exports
- File paths that no longer exist
- Build output paths (the build emits `.mjs` + `.d.mts` to `dist/`)
- Configuration examples using deprecated schema fields
- Missing documentation for new features
</context>

<instructions>
Systematically verify all README and documentation against the actual code:

1. Find all docs: `find . -name "*.md" -not -path "./node_modules/*" -not -path "./.git/*"`

2. For each, verify:
   - Package name matches `package.json` `name`
   - Command examples use real flags (check `src/cli.mts` argv parsing)
   - File paths exist
   - Build output paths match scripts
   - API examples match exports
   - Config examples match `MeanderConfigSchema` in `src/config.mts`
   - Versions are current

3. Check against actual code (read package.json, source files, CLI argv parsing, tests).

4. Pattern categories:

<pattern name="package_names">
- README showing `meander` when `package.json` has `@divmain/meander`
- Install instructions with wrong package name
- Import examples using wrong name
</pattern>

<pattern name="command_examples">
- Flags that don't exist in `src/cli.mts`
- Missing required flags in examples
- Deprecated flags still documented
- Examples that would error if run as-is
- Wrong subcommand names
</pattern>

<pattern name="file_paths">
- Paths that don't exist
- Output paths that don't match build
- Config file locations incorrect
- Source file references outdated
</pattern>

<pattern name="api_documentation">
- Functions documented that don't exist in exports
- Parameter types that don't match implementation
- Return types incorrectly documented
- Missing required parameters in examples
</pattern>

<pattern name="configuration">
- Config examples using wrong keys vs. `MeanderConfigSchema`
- Documented options not validated in code
- Missing required config fields (`slug`, `title`, `parts[]`)
- Wrong default values
- Obsolete formats
</pattern>

<pattern name="build_outputs">
- Build output paths that don't match `tsconfig.json` `outDir` (`dist/`)
- File names that are incorrect (`.mjs` + `.d.mts`)
- Missing intermediate stages
</pattern>

<pattern name="version_information">
- Outdated dependency versions
- Wrong tool version requirements
- Node version mismatches vs. `.node-version` and `package.json` `engines.node`

When in doubt about a version, skip the finding rather than "correct" it. CLAUDE.md note: never blindly change version numbers based on `git describe` from a dependency.
</pattern>

<pattern name="claude_md_drift">
CLAUDE.md must stay in sync with what the code and scripts actually do. Flag drift like:
- A script listed in `## Commands` that doesn't exist in `package.json` `scripts`
- A hook listed in `## Agents & Hooks` that's not in `.claude/hooks/`
- A configuration file listed in the table that's missing or moved
- A "FORBIDDEN" rule that the code violates (e.g. `import fs from "node:fs"` showing up while CLAUDE.md says cherry-pick)
- The pinned Node version differing between `.node-version` and CLAUDE.md
</pattern>

<pattern name="missing_documentation">
- Public APIs / exports not documented in README
- Important env vars not documented (`VALTOWN_API_TOKEN`, ceremony-related secrets)
- New features added without docs
- Critical sections (75%+ of feature) not mentioned
</pattern>

For each issue:
1. Read the documented information
2. Read the actual code/config
3. Determine the discrepancy
4. Provide the correction
</instructions>

<output_format>
For each finding, report:

File: path/to/<file>.md:lineNumber
Issue: [One-line description]
Severity: High | Medium | Low
Pattern: [Incorrect documentation text]
Actual: [What the code/config actually shows]
Fix: [Exact correction]
Impact: [Why this matters]

Severity guide:
- High — wrong commands, non-existent APIs, install instructions that fail
- Medium — outdated paths, wrong defaults, drift from CLAUDE.md
- Low — minor inaccuracies, missing non-critical info

Example:
File: README.md:46
Issue: Documents non-existent CLI subcommand
Severity: High
Pattern: "`meander deploy` deploys the comment backend"
Actual: `src/cli.mts` registers `deploy-val`, not `deploy`
Fix: Change to "`meander deploy-val` deploys the comment backend to Val Town"
Impact: Users following the README hit "unknown subcommand" and bounce
</output_format>

<quality_guidelines>
- Verify every claim against the actual code; don't assume the doc is correct.
- Read package.json, source, tests.
- Run `--help` (or read argv parsing in `src/cli.mts`) to verify CLI flags.
- Check exports in source to verify APIs.
- Focus on high-impact errors first.
- Group related issues (e.g. "5 examples using deprecated config field").
- Provide exact fixes, not vague suggestions.
</quality_guidelines>

Scan all markdown documentation and report all inaccuracies. If the documentation is accurate, state that explicitly.
```

---

<a id="severity-levels"></a>
## 7. Severity levels

| Level | Description | Action |
|---|---|---|
| **Critical** | Crashes, security vulnerabilities, data corruption | Fix immediately |
| **High** | Logic errors, incorrect output, resource leaks | Fix before release |
| **Medium** | Performance issues, edge-case bugs | Fix in the next sprint |
| **Low** | Code smells, minor inconsistencies | Fix when convenient |

### Scan priority order

1. **critical** — most important, run first
2. **logic** — correctness of comment/code pairing, classifiers, URL rewriting, schema
3. **workflow** — developer experience, CI hygiene
4. **security** — GitHub Actions hardening
5. **documentation** — README, docs, CLAUDE.md drift

### Coverage targets

- **critical**: all files under `src/` and `scripts/`
- **logic**: `src/` (especially `generate.mts`, `classifiers.mts`, `url-rewrite.mts`, `config.mts`, `crypto.mts`, `shamir.mts`) and `assets/val/`
- **workflow**: `scripts/`, `package.json`, `.git-hooks/`, `.github/workflows/`
- **security**: `.github/workflows/*.yml`
- **documentation**: `README.md`, `docs/*.md`, `CLAUDE.md`

---

<a id="report-template"></a>
## 8. Report template

Use this format for the Phase 8 report:

```markdown
# Quality Scan Report

**Date:** YYYY-MM-DD
**Repository:** meander (`@divmain/meander`)
**Scans:** [list]
**Files scanned:** N
**Findings:** N critical, N high, N medium, N low

## Dependency updates

**Status:** N packages updated
**Result:** Success / Failed

## Structural validation

`pnpm run check` results:
- Lint errors: N (Critical findings below)
- Lint warnings: N (Low findings below)
- Type errors: N (Critical findings below)

## Critical Issues (Priority 1) - N found

### src/path/to/file.mts:89
- **Issue**: [description]
- **Pattern**: [code snippet]
- **Trigger**: [what triggers it]
- **Fix**: [suggested fix]
- **Impact**: [consequence]
- **Scan**: critical

## High Issues (Priority 2) - N found

[Same format]

## Medium Issues (Priority 3) - N found

[Same format]

## Low Issues (Priority 4) - N found

[Same format]

## Scan coverage

- **Dependency updates**: N packages updated
- **Structural validation**: `pnpm run check` exit code <code>
- **Critical scan**: N files analyzed
- **Logic scan**: N files analyzed
- **Workflow scan**: N scripts + package.json + N workflows
- **Security scan**: N workflows analyzed
- **Documentation scan**: N markdown files analyzed

## Recommendations

1. Address N critical issues immediately before next release.
2. Review N high-severity logic errors.
3. Schedule N medium issues for the next sprint.
4. Low-priority items can wait for the next refactor.
```

### Structured finding shape

When emitting findings programmatically:

```typescript
{
  file: "src/generate.mts:89",
  issue: "Off-by-one when stacking multi-line comments",
  severity: "High",
  scanType: "logic",
  pattern: "for (let i = 0; i < comments.length - 1; i++)",
  fix: "for (let i = 0; i < comments.length; i++)",
  impact: "Final part is silently dropped from emitted output"
}
```

---

<a id="completion-summary"></a>
## 9. Completion summary

Report these final metrics when Phase 9 emits the completion signal:

```
Quality Scan Complete
=====================
- Dependency updates: N packages updated
- Structural validation: N errors, N warnings (`pnpm run check`)
- Repository cleanup: N junk files removed
- Scans completed: [list]
- Total findings: N (N critical, N high, N medium, N low)
- Files scanned: N
- Report generated: Yes
- Scan duration: <calculated>

Critical issues requiring immediate attention:
- N critical findings
- See report for details and fixes

Next steps:
1. Address critical issues immediately.
2. Review high-severity findings.
3. Schedule medium / low issues appropriately.
4. Re-run scans after fixes to verify.
```

---

<a id="edge-cases"></a>
## 10. Edge cases

### No findings

```markdown
# Quality Scan Report

**Result**: No issues found

All scans completed successfully.

- Critical scan: clean
- Logic scan: clean
- Workflow scan: clean
- Security scan: clean
- Documentation scan: clean

**Code quality**: Excellent
```

### Scan failures

If an agent fails or times out:

```markdown
## Scan errors

- **critical scan**: failed (agent timeout)
  - Retry recommended
  - Check agent prompt size

- **logic scan**: completed
- **workflow scan**: completed
- **security scan**: completed
- **documentation scan**: completed
```

### Partial scans

The user can request specific scan types — for example, only critical and logic. The report includes only the requested scans and notes which were skipped.
