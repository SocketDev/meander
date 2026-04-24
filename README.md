<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/logo-bezel-dark.svg">
    <img alt="meander" src="assets/logo/logo-bezel-light.svg" width="420">
  </picture>
</p>

<h1 align="center">meander</h1>

<p align="center">
  Annotated code walkthrough pages with a live comment system, hosted on <a href="https://val.town">Val Town</a>.
</p>

<p align="center">
  <a href="https://socket.dev/npm/package/@divmain/meander"><img alt="Socket Badge" src="https://socket.dev/api/badge/npm/package/@divmain/meander"></a>
  <a href="https://github.com/divmain/meander/actions/workflows/ci.yml"><img alt="CI - @divmain/meander" src="https://github.com/divmain/meander/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Coverage" src="https://img.shields.io/badge/coverage-99%25-brightgreen">
</p>

---

Meander turns `/* … */` comments in your source files into a
narrated, navigable walkthrough. Each comment becomes a prose
card; the code that follows becomes the paired, highlighted code
block. Readers can leave threaded comments on any line range.

The generator emits static HTML. Comments are stored server-side
in a Val Town val (SQLite + blob storage, encrypted at rest) —
you only need that piece if you want the commenting layer.

## Features

- **Side-by-side prose + code** — each block comment pairs with
  the code that follows it.
- **Multi-part walkthroughs** — split a codebase into ordered
  parts; the top nav moves readers between them.
- **Go-to-definition** — exported symbols are indexed so readers
  can jump to any definition across parts.
- **Line-range commenting** — shift-click to select lines, type a
  comment, reply, resolve, delete.
- **Documents tab** — optional Markdown pages with syntax
  highlighting, a floating table of contents, block-level
  comments, and cross-doc links.
- **Reader UX** — resizable prose/code splitter, jump-to-file
  menus, theme toggle, Cmd/Ctrl-click hotlinks, JSDoc annotation,
  opt-in Mermaid pre-rendering.
- **Val Town hosting** — one Hono val serves every walkthrough
  out of blob storage, with encryption at rest.

See [docs/features.md](docs/features.md) for the full feature
list and configuration knobs.

## Install

```bash
pnpm install -g @divmain/meander
```

Or run without installing:

```bash
npx @divmain/meander generate meander.config.json
```

**Requirements**: Node >= 20.

## Quick start

### 1. Annotate your source

Add block comments anywhere in your source files. The comment
becomes the prose; the code that follows (up to the next comment
or end-of-file) becomes the paired code block.

```typescript
/*
 * Load the application configuration from environment variables,
 * falling back to sensible defaults when a variable is absent.
 */
export function loadConfig(): Config {
  return {
    port: Number(process.env['PORT'] ?? 3000),
    version: process.env['API_VERSION'] ?? 'v1',
  }
}
```

Prose inside the comment supports full Markdown.

### 2. Describe the walkthrough

Create `meander.config.json` at the root of your project:

```json
{
  "slug": "my-project",
  "title": "My Project Walkthrough",
  "parts": [
    {
      "id": 1,
      "title": "Configuration",
      "objective": "Understand how the app is configured at startup.",
      "keywords": ["config", "env"],
      "files": ["src/config.ts", "src/defaults.ts"]
    },
    {
      "id": 2,
      "title": "Request Handling",
      "objective": "See how incoming requests are routed and processed.",
      "keywords": ["router", "handler", "middleware"],
      "files": ["src/router.ts", "src/handlers/index.ts"]
    }
  ]
}
```

### 3. Build + preview

```bash
meander generate meander.config.json   # emit HTML
meander serve meander.config.json      # local preview at http://127.0.0.1:8080
```

`generate` writes into `pages/` next to your config:

```
pages/
  index.html        part listing
  part-1.html       one file per part
  part-2.html
  meander.css       shared styles
  manifest.json     build summary
```

## Config reference

### Top-level fields

| Field        | Type       | Required | Description                                                                 |
| ------------ | ---------- | -------- | --------------------------------------------------------------------------- |
| `slug`       | `string`   | Yes      | URL-safe identifier, `[a-z0-9][a-z0-9-]*`. Used in URLs and storage keys.   |
| `title`      | `string`   | Yes      | Title shown on the index page.                                              |
| `parts`      | `Part[]`   | Yes      | Ordered list of walkthrough parts (at least one).                           |
| `documents`  | `string[]` | No       | Markdown files to render as a Documents tab, relative to the config file.   |
| `outDir`     | `string`   | No       | Directory to emit into, default `pages`. Also the Val Town blob prefix.     |

### Part fields

| Field       | Type       | Required | Description                                                                  |
| ----------- | ---------- | -------- | ---------------------------------------------------------------------------- |
| `id`        | `integer`  | Yes      | Unique part number (starts at 1).                                            |
| `title`     | `string`   | Yes      | Short title shown in the nav.                                                |
| `objective` | `string`   | Yes      | One sentence describing what the reader will learn.                          |
| `keywords`  | `string[]` | Yes      | Words used to resolve ownership when a file appears in multiple parts.      |
| `files`     | `string[]` | Yes      | Source files in this part, relative to the config file.                     |
| `filename`  | `string`   | No       | URL-friendly slug for clean part URLs (`/:slug/parts/<filename>.html`).     |

### How `keywords` resolves overlap

When the same file appears in multiple parts, meander picks an
owner per comment block using keyword scoring. Each `keywords`
list is checked against the block's cleaned text and its file
path; the part with the most matches wins, ties broken by
config order. Pick keywords that distinguish parts, not generic
terms.

### Full reference

The full schema — comments / theme / styles opt-outs, favicon
overrides, CSP, SRI, mermaid, minify, service worker — lives in
[`docs/features.md`](docs/features.md).

## Publishing with comments

The commenting layer runs in a Val Town val. If you only want
static pages, you can skip this — `meander serve` previews the
HTML standalone.

To deploy the val + publish encrypted pages:

```bash
meander deploy-val                     # first-time val setup
meander publish meander.config.json    # upload encrypted HTML
```

See [docs/publishing.md](docs/publishing.md) for the full setup
(env vars, CI integration, graceful skip for fork PRs).

## Examples

- [`example/minimal/`](example/minimal/) — the smallest runnable
  meander project. Start here.
- [`example/consumer-build/`](example/consumer-build/) —
  integrating meander as a step in your own build pipeline (CLI,
  programmatic, GH Pages workflow).

## Further reading

- [Features + configuration](docs/features.md) — every opt-in and
  opt-out knob, with examples.
- [Publishing](docs/publishing.md) — Val Town setup, token scopes,
  CI integration.
- [Comment API](docs/comment-api.md) — the REST endpoints the
  browser client hits.
- [Encryption at rest](docs/encryption.md) — what's encrypted,
  key derivation, binary format.
- [Contributing](docs/contributing.md) — working on meander
  itself: tests, CI, style, architecture tour.

## License

MIT
