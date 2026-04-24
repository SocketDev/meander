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

---


You write `/* ... */` prose comments directly in your source files. Meander parses them, pairs each comment with the code that follows it, and generates a set of static HTML pages — one per walkthrough part — served through a Hono HTTP handler deployed to your Val Town account. Readers can leave threaded comments on any line range, resolve discussions, and export the full comment history as JSON.

## Features

- **Side-by-side annotation + code** — each block comment becomes a prose card paired with the highlighted source code that follows it
- **Multi-part walkthroughs** — split a codebase into ordered parts; a top nav lets readers move between them
- **Go-to-definition linking** — exported symbols are indexed so readers can jump to any definition across parts
- **Line-range commenting** — shift-click to select lines, type a comment, reply in threads, resolve or delete
- **Documents tab** — optional Markdown files rendered with syntax highlighting, a floating table of contents, block-level comments, and cross-document links
- **Unresolved comments widget** — a dropdown listing every open thread with direct links
- **JSON comment export** — download all (or only unresolved) comments as structured JSON
- **Val Town hosting** — a single Hono val serves all walkthroughs behind HTTP basic auth, storing HTML in blob storage and comments in SQLite
- **Encryption at rest** — HTML files and comment content are encrypted with AES-256-GCM; the encryption key is derived from your basic auth password

## Installation

```bash
npm install -g @divmain/meander
```

Or use it without installing:

```bash
npx @divmain/meander generate walkthrough.json
```

## Quick Start

### 1. Annotate your source files

Add multiline comments (`/* ... */`) anywhere in your source files. The comment becomes the prose annotation; the code that follows (until the next comment or end-of-file) becomes the paired code block.

```typescript
/*
 * Load the application configuration from environment variables,
 * falling back to sensible defaults when a variable is absent.
 */
export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT ?? "3000", 10),
    version: process.env.API_VERSION ?? "v1",
  };
}
```

Annotations support full Markdown (rendered client-side via `marked`).

### 2. Create `walkthrough.json`

Place `walkthrough.json` at the root of your project:

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

### 3. Generate the HTML

```bash
meander generate walkthrough.json
```

This writes the following files into a `walkthrough/` directory next to your config:

```
walkthrough/
  index.html                  # Part listing
  walkthrough-part-1.html     # One file per part
  walkthrough-part-2.html
  walkthrough.css             # Styles (copied from package assets)
  manifest.json               # Build summary
```

Open any HTML file directly in a browser to preview locally. (The comment system requires the Val Town backend to function.)

## Configuration Reference

### `walkthrough.json` fields

| Field | Type | Required | Description |
|---|---|---|---|
| `slug` | `string` | Yes | URL-safe identifier for this walkthrough (`[a-z0-9][a-z0-9-]*`). Used in all blob storage keys and URL paths. |
| `title` | `string` | Yes | Human-readable title shown in the index page. |
| `parts` | `Part[]` | Yes | Ordered list of walkthrough parts (at least one). |
| `documents` | `string[]` | No | Paths to Markdown files (relative to the config file) to render as a Documents tab. Must end in `.md`. |

### Part fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `integer` | Yes | Unique part number starting from 1. Used in file names and URL paths. |
| `title` | `string` | Yes | Short part title shown in the nav bar. |
| `objective` | `string` | Yes | One-sentence description of what the reader will learn. |
| `keywords` | `string[]` | Yes | Words used to assign comments to this part when a file appears in multiple parts. |
| `files` | `string[]` | Yes | Source files for this part, relative to the directory containing `walkthrough.json`. |

### Section assignment

When the same file appears in multiple parts, Meander uses keyword scoring to decide which part owns each comment block. A block's cleaned text and its file path are checked against each candidate part's `keywords` list. The part with the most keyword matches wins. If scores tie, the part that appears first in the config wins.

## Documents Tab

Add a `documents` array to your config to enable a tabbed reference docs section:

```json
{
  "slug": "my-project",
  "title": "My Project",
  "documents": [
    "docs/overview.md",
    "docs/api.md",
    "docs/architecture.md"
  ],
  "parts": [...]
}
```

Each Markdown file is rendered with:

- Syntax-highlighted code blocks (highlight.js)
- Auto-generated heading IDs and a floating table of contents
- Block-level comments (shift-click to select paragraph blocks)
- Cross-document links: links to other `.md` files in the `documents` list are resolved client-side without page navigation

Cross-document links work with relative paths:

```markdown
See [API docs](./api.md) or jump to [a specific section](./api.md#authentication).
```

## Publishing to Val Town

### Prerequisites

- A [Val Town](https://val.town) account
- A Val Town API token (create one at `https://val.town/settings/api`)

### Set up environment variables

```bash
export VALTOWN_TOKEN=vtwn_...
export WALKTHROUGH_USER=youruser
export WALKTHROUGH_PASS=yourpassword
```

`WALKTHROUGH_USER` and `WALKTHROUGH_PASS` are the HTTP basic auth credentials that protect your hosted walkthroughs. `WALKTHROUGH_PASS` is also used to derive the encryption key for all stored content — changing it will make existing encrypted data inaccessible until you re-publish and clear comments.

### Deploy the val (first time only)

```bash
meander deploy-val
# or with a custom val name:
meander deploy-val my-walkthrough-val
```

This creates (or updates) a Val Town HTTP val running the Hono server, and sets `WALKTHROUGH_USER` / `WALKTHROUGH_PASS` as val environment variables.

### Publish HTML

```bash
meander generate walkthrough.json
meander publish walkthrough.json
```

`publish` encrypts the generated HTML files with AES-256-GCM and uploads them to Val Town blob storage under keys like `walkthrough/<slug>/walkthrough-part-1.html`. The shared CSS file is uploaded unencrypted (since browsers must read it directly). After publishing, your walkthrough is live at:

```
https://<username>-<valname>.web.val.run/<slug>/
```

Re-publish after regenerating to update the live content. The val itself only needs to be redeployed when you want to update the server code.

## Encryption at Rest

All user content is encrypted before storage using AES-256-GCM via the Web Crypto API.

### What is encrypted

| Data | Encryption |
|---|---|
| Walkthrough HTML files (`index.html`, `walkthrough-part-*.html`, `documents.html`) | AES-256-GCM with unique IV per file |
| Comment `body` and `author` fields | AES-256-GCM with unique IV per comment |
| Comment metadata (`id`, `file`, `line_from`, `line_to`, `parent_id`, `resolved`, `created_at`) | **Not encrypted** — stored as plaintext |
| CSS file (`walkthrough.css`) | **Not encrypted** — served directly by browsers |
| Manifest (`manifest.json`) | **Not encrypted** — contains only metadata |

### Key derivation

The encryption key is derived from `WALKTHROUGH_PASS` using PBKDF2-SHA256 with 600,000 iterations and a fixed salt. This means:

- **No additional credentials** — the same password protects both access (basic auth) and data (encryption)
- **Deterministic key** — the same password always produces the same key, so the val and publish CLI stay in sync automatically
- **Password rotation** — changing `WALKTHROUGH_PASS` requires re-publishing all walkthroughs (HTML files) and clears all existing comments (since old encrypted data becomes undecryptable)

### Binary format

Encrypted values are stored as base64-encoded:

```
[1 byte: version 0x01][12 bytes: random IV][N bytes: AES-GCM ciphertext + 16-byte auth tag]
```

The version byte enables future algorithm migrations without breaking existing deployments.

## Comment System

The hosted val exposes a REST API used by the browser client:

| Method | Path | Description |
|---|---|---|
| `GET` | `/:slug/api/comments?part=N` | Fetch all comments for a part |
| `POST` | `/:slug/api/comments` | Create a new comment or reply |
| `PATCH` | `/:slug/api/comments/:id` | Resolve or unresolve a comment |
| `DELETE` | `/:slug/api/comments/:id` | Delete a comment |
| `GET` | `/:slug/api/comments/unresolved` | List all unresolved root comments |
| `GET` | `/:slug/api/comments/export` | Download comments as JSON |

Comments are stored in a Val Town SQLite database scoped by `slug` and `part`, so multiple walkthroughs share the same val without conflict. Comment `body` and `author` fields are encrypted at rest using AES-256-GCM; metadata (file paths, line numbers, resolved status, timestamps) remains unencrypted.

## Supported File Types

Syntax highlighting is applied automatically based on file extension:

| Extension | Language |
|---|---|
| `.ts`, `.tsx` | TypeScript / TSX |
| `.js`, `.mjs` | JavaScript |
| `.json` | JSON |
| `.sh` | Bash |
| anything else | plaintext |

## Local Preview

Generated HTML files reference assets from the deployed val (`/walkthrough.css`, highlight.js CDN). To preview locally without a val, open any generated `.html` file directly — layout and code formatting will work, but the nav links and comment API will not.

## License

MIT
