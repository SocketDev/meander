# AGENTS.md

Guidelines for AI coding agents operating in the `@divmain/meander` repository.

## Project Overview

Meander is a TypeScript CLI tool that generates annotated code walkthrough HTML pages
with an interactive comment system, hosted on Val Town. The codebase has two layers:

- **`src/`** — 4 TypeScript source files (CLI, generate, publish, deploy-val)
- **`assets/`** — Vanilla JavaScript browser scripts and CSS inlined into generated HTML
- **`assets/val/`** — Hono HTTP handler deployed as a Val Town val (Deno runtime)

Dependencies: `@sinclair/typebox` (schema validation), `@valtown/sdk`, `marked` (Markdown).

## Build / Lint / Test Commands

```bash
npm run build          # Compile TypeScript (runs `tsc`)
npx tsc --noEmit       # Type-check without emitting (useful for verification)
```

- **No linter or formatter is configured.** There are no eslint, prettier, or biome configs.
  Follow the style conventions documented below.
- **No test framework is configured.** There are no automated tests.
  `test-walkthrough-docs/` and `test-walkthrough-no-docs/` are manual fixture directories.
- **No CI/CD.** There are no GitHub Actions or other pipeline configs.

### Running Locally

```bash
npm run build
node dist/cli.js generate <path-to-walkthrough.json>
node dist/cli.js publish <path-to-walkthrough.json>    # requires VALTOWN_TOKEN
node dist/cli.js deploy-val [val-name]                  # requires VALTOWN_TOKEN, WALKTHROUGH_USER, WALKTHROUGH_PASS
```

## Code Style

### Formatting

- **2-space indentation** everywhere (TypeScript and JavaScript).
- **Double quotes** for strings in TypeScript. Single quotes only inside HTML template literals
  for attribute values.
- **Semicolons always** — never rely on ASI.
- **Trailing commas** in multi-line objects, arrays, and parameter lists.

### Imports

Order imports in this sequence with no blank lines between them:

1. Third-party npm packages
2. Node.js built-ins (always use the `node:` prefix — `"node:fs"`, `"node:path"`)
3. Local/relative modules

```typescript
import { Type, type Static } from "@sinclair/typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
```

- Prefer **named imports**. Use default imports only when the library API requires it.
- Use inline `type` keyword for mixed value+type imports: `import { Type, type Static } from ...`
- Use `import type` as a separate statement for type-only imports.

### Naming Conventions

| Kind                        | Convention          | Example                           |
|-----------------------------|---------------------|-----------------------------------|
| Variables, functions        | `camelCase`         | `configPath`, `escapeHtml`        |
| Types, interfaces, classes  | `PascalCase`        | `Block`, `Section`, `ApiComment`  |
| TypeBox schemas             | `PascalCase+Schema` | `WalkthroughConfigSchema`         |
| True constants              | `UPPER_SNAKE_CASE`  | `API_BASE`, `FILE_LANG`           |
| Database columns            | `snake_case`        | `line_from`, `parent_id`          |
| CSS classes (in JS)         | `kebab-case`        | `"comment-add-btn"`               |

### Types

- Use **`type`** for internal/structural data shapes.
- Use **`interface`** for external API contracts and exported type definitions.
- **Explicitly annotate** function parameters and return types.
- Let TypeScript **infer** local variable types when the type is obvious.
  Use explicit annotations for empty collections (`const blocks: Block[] = []`) and
  unsafe data (`const raw: unknown = JSON.parse(...)`).
- Mark array parameters that should not be mutated with **`readonly`**:
  `function buildSections(parts: readonly WalkthroughPart[]): Section[]`
- **No enums.** Use string literals and `Record` maps instead.
- Use **`satisfies`** for type-checking literal expressions without widening.

### Functions

- Use **`function` declarations** for all named/top-level functions (not arrow functions).
- Use **arrow functions** only as inline callbacks (`.map()`, `.filter()`, `.catch()`).
- Each `src/` module exports **exactly one primary async function** via named export.
  The CLI dynamically imports them: `const { generate } = await import("./generate.js")`.

### Error Handling

- Use **`process.exitCode = 1`** and `return` — never call `process.exit()` directly.
- Top-level entry points catch with: `main().catch((error) => { ... process.exitCode = 1; })`.
- Validate preconditions early with **guard clauses** (throw or early return).
- Use **bare `catch {}`** (no parameter) when intentionally ignoring expected errors
  (e.g., SQLite migrations where a column may already exist).
- HTTP errors: check `res.ok` and throw with status + body text.
- Include the error path/context in thrown `Error` messages.

### Comments

Use section dividers to separate logical areas of a file:

```typescript
/* ------------------------------------------------------------------ */
/*  Section Title                                                      */
/* ------------------------------------------------------------------ */
```

- The dash line is 66 characters. The title line is right-padded with spaces to align `*/`.
- Use **JSDoc** (`/** ... */`) with `@param` / `@returns` for exported/public functions.
- Use `//` inline comments sparingly for brief clarifications.
- Use **em-dashes (—)** instead of double-dashes in prose comments.

### Module / Export Patterns

- **Named exports only** from TypeScript source files (no default exports).
- Exception: `assets/val/index.ts` exports `default` (required by Hono/Val Town).
- Export types with `export type` or `export interface`.

### Browser JavaScript Conventions (`assets/*.js`)

Browser scripts target older runtimes and follow different rules:

- **ES5 compatible** — use `var` (never `const`/`let`), `function` expressions (never arrows),
  classic `for` loops (never `for...of`), string concatenation (never template literals).
- Wrap every file in an **IIFE**: `(function () { "use strict"; ... })();`
- Use the **DOMContentLoaded guard** pattern in every script:
  ```javascript
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
  ```
- Use IIFE closures to capture loop variables for event handlers.

### Other Patterns

- Prefer **`for...of`** over `.forEach()` in TypeScript source.
- Use **`Map` and `Set`** for collections in TypeScript (plain objects in browser JS).
- Access environment variables with **bracket notation**: `process.env["VALTOWN_TOKEN"]`.
- Use **non-null assertions (`!`)** for known-safe array accesses: `defs[0]!`.
- Use **`Omit<>`** and intersection types (`&`) for type derivation.
