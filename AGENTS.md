# AGENTS.md

Guidelines for AI coding agents operating in the `@divmain/meander` repository.

## Project Overview

Meander is a TypeScript CLI that turns block comments in source
files into navigable walkthrough pages, with an optional live
comment system hosted on Val Town.

- **`src/*.mts`** — CLI + generator (HTML emission, schema,
  annotation pipeline, PURL rendering, publish, deploy-val,
  serve, minify, security passes, render-mermaid, doctor).
- **`assets/*.js`** — client-side scripts inlined into emitted
  HTML (ES5-compatible IIFEs).
- **`assets/val/`** — the Hono HTTP handler deployed to Val
  Town, serving encrypted blobs + the comment API.
- **`test/`** — vitest suite. Fixtures under `test/fixtures/`.
- **`scripts/`** — dev automation (`build`, `test`, `cover`,
  `lint`, `fix`, `check`, `clean`, `dev`).

See `package.json` for the current dep list.

## Commands

See [docs/contributing.md](docs/contributing.md) for the full set.
Short version: `pnpm build`, `pnpm test`, `pnpm cover`, `pnpm
check`, `pnpm fix`, `pnpm dev`.

## Code Style

### Formatting

oxfmt enforces the style — see `.oxfmtrc.json`. Highlights:

- **2-space indentation** everywhere.
- **Single quotes** for strings. Double quotes inside JSX / HTML
  attribute values.
- **No semicolons** (ASI).
- **Arrow parens avoided** when safe (`x => x.id`, not `(x) => x.id`).
- **Trailing commas** in multi-line objects, arrays, and parameter lists.

### Imports

oxfmt sorts imports into three groups separated by blank lines:

1. Node built-ins (always `node:` prefix — `'node:fs'`).
2. Third-party npm packages.
3. Local/relative modules.

```typescript
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Type } from '@sinclair/typebox'
import type { Static } from '@sinclair/typebox'

import { loadMeanderConfig } from './config.mts'
```

- Prefer **named imports**. Default imports only when the library
  requires it (e.g. `import path from 'node:path'`).
- Type-only imports are **always** separate `import type`
  statements — never inline `type` in a value import.

### Naming Conventions

| Kind                        | Convention          | Example                           |
|-----------------------------|---------------------|-----------------------------------|
| Variables, functions        | `camelCase`         | `configPath`, `escapeHtml`        |
| Types, interfaces, classes  | `PascalCase`        | `Block`, `Section`, `ApiComment`  |
| TypeBox schemas             | `PascalCase+Schema` | `MeanderConfigSchema`             |
| True constants              | `UPPER_SNAKE_CASE`  | `API_BASE`, `FILE_LANG`           |
| Database columns            | `snake_case`        | `line_from`, `parent_id`          |
| CSS classes (in JS)         | `kebab-case`        | `'comment-add-btn'`               |

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
  The CLI dynamically imports them: `const { generate } = await import('./generate.mts')`.

### Error Handling

- Use **`process.exitCode = 1`** and `return` — never call `process.exit()` directly.
- Top-level entry points catch with: `main().catch(e => { ... process.exitCode = 1 })`.
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
  (double quotes + semicolons in assets/*.js are intentional —
  these are classic scripts, not modules, and we keep them
  consistent with the surrounding browser-targeted style).
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
- Access environment variables with **bracket notation**: `process.env['MEANDER_OUT_DIR']`.
- Use **non-null assertions (`!`)** for known-safe array accesses: `defs[0]!`.
- Use **`Omit<>`** and intersection types (`&`) for type derivation.
