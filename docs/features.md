# Reader-facing features

Each generated walkthrough part page ships a set of reading
affordances, all framework-free (no runtime deps beyond
highlight.js). Consumers opt in or out through
`walkthrough.json`; most features are on by default.

## Column splitter

Every `.file-block` has a vertical handle between the prose
column and the code column. Drag to resize, double-click to
reset to 50/50, keyboard-accessible with arrow keys (Home / End
jump to 20% / 80%). The ratio persists to `localStorage` under
`meander:pages:col-split`. Hidden on viewports narrower than
1100px (layout collapses to a single column, nothing to split).

No configuration — always on.

## Jump-to-file menu

When a part page has two or more files, each `.file-head`'s path
text becomes a `<details>` dropdown listing every file on the
page with the current file pre-marked active. Single-file pages
render the path as plain text (no useless dropdown).

An `IntersectionObserver` tracks which `.file-block` is topmost
in the viewport and updates the active row across all open
menus as the reader scrolls.

No configuration — always on when ≥2 files per part.

## Per-file sections menu + per-chunk chips

When a file has two or more sections, the "N sections" count in
the `.file-head` becomes a second `<details>` dropdown listing
every section ("Section 1 — Lines 6–9", …) so readers can jump
directly to a chunk without scrolling.

Each `.code-section` also carries a small chip at top-right
("Section N of M"). The chip's panel ships empty; the first
open clones the file-head's full menu into it client-side and
pre-marks the current chunk active. This saves repeated markup
on files with many sections.

No configuration — always on when ≥2 sections per file.

## Theme toggle (system / light / dark / neo-kijū)

A 30×30 icon in `.topbar-actions` opens a menu with four
choices. The pick persists to `localStorage` under
`meander:pages:theme`; a stored value resolves synchronously in
`<head>` before first paint, so dark-preferring systems never
flash the light theme.

The four SVG icons stack on top of each other via
`position: absolute; inset: 0; margin: auto`, so switching
preference only flips opacity — the button never reflows.

### Neo-Kijū

A fourth theme option, labeled **Neo-Kijū** in the menu
(internal id: `neo-kiju`). Deep-purple palette with an
electric-violet accent, code keywords in hot pink. Its icon
is a lightning bolt flanked by three small sparks; on a live
user-click switch, the bolt plays a one-shot scale-up strike
and the three sparks flicker in sequence over ~1.5s. A page
reload that just restores `neo-kiju` from localStorage paints
the bolt at rest — animations are gated on
`mdr-theme-toggle-fired` so the reader only sees motion on
their own action.

Unlike `system` / `light` / `dark`, `neo-kiju` is its own
palette rather than a light/dark variant. `system` preference
still resolves only to light or dark.

No configuration — always on.

## Cmd/Ctrl-click links in code

Inside every `.line-code` cell:

- **URLs** (`http://…` / `https://…`) become `<a target="_blank">`
  that open in a new tab.
- **Quoted relative paths** (`"./foo.js"`, `'../bar'`) resolve
  against the enclosing file's path; if the resolved path
  matches another `.file-block` on the page, the link scrolls
  there. Falls back to basename match (so `./foo.js` resolves
  to `foo.ts` if that's what meander emitted).

Both are invisible at rest — no underline, no pointer, same
color as surrounding code. Holding Cmd (macOS) or Ctrl
(elsewhere) flips `body.mdr-mod-pressed`; CSS reveals a dotted
underline + pointer. Plain clicks are blocked so code selection
still works.

No configuration — always on. Runs after hljs has tokenized
code (hljs splits text nodes; wrapping before it would get
blown away).

## JSDoc annotation pipeline

Three client-side passes that clean up JSDoc-style source
comments rendered through markdown:

1. **Unwrap spurious mailto links.** Marked's auto-linker turns
   `name@1.2.3` into `<a href="mailto:name@1.2.3">`; this
   unwraps it.
2. **Wrap @tags.** Text like `@param`, `@returns`, `@throws`,
   `@example`, etc. becomes a `<span class="mdr-jsdoc-tag">`
   pill. Optional `{Type}` annotations become inline `<code>`.
3. **Group into blocks + reorder.** Each tag + its following
   content becomes a `<span class="mdr-jsdoc-block">`. Final
   order is: `[@fileoverview?, @description?, others…]`.
   @example blocks absorb adjacent `<pre>` siblings; @param
   extracts the parameter name into an inline pill; `{Type}`
   annotations lift up next to the tag on the header strip.

`.annotation-md` ships with `opacity: 0` to avoid a flash of
unstyled @-markers; the orchestrator adds
`.mdr-annotation-md-ready` at the start of its pass so the
cleaned DOM composites in the same paint.

Gated on hljs being ready (for @example highlighting). No-op on
pages without JSDoc content or hljs.

## Prose polishers

Five pure string transforms applied to every rendered doc and
every annotation body on the server side. Idempotent; safe to
run multiple times.

- **`highlightProseNumbers`** — wraps digit tokens and version
  strings (`1.2.3`, `95%`, `23+`, `~42`) in
  `<span class="mdr-num">` for accent-color styling. Allow-
  listed to prose elements (p, li, td, blockquote, h1–h4); skips
  code/pre/a/kbd/samp. Declines to re-color bold list markers
  (`**1.** Branch`).
- **`italicizeParentheticals`** — wraps `(aside)` in `<em>` so
  parentheticals read quieter than inline copy. 2+-char contents,
  no nested parens/tags/quotes.
- **`anchorifyHeadings`** — appends a GitHub-style `#` permalink
  to every h2/h3/h4. The anchor is `opacity: 0` at rest and
  fades in on heading hover. Slugs dedupe with `-2`, `-3`, …
  suffixes.
- **`enhanceRepoTrees`** — detects ASCII directory trees
  (contain `├──` / `└──` / `│`) and tags the `<pre>` with
  `.mdr-repo-tree` + the inner `<code>` with `nohighlight` so
  hljs doesn't paint the drawing glyphs as random tokens.
- **`stripFurtherReading`** — removes the
  `<h2>Further reading</h2>` section + every sibling until the
  next `<h2>`. README-style cross-reference lists become dead
  links once docs are split into separate walkthrough pages.

No configuration — always on for doc and annotation renders.

## Mermaid diagram pre-rendering

**Opt-in.** When enabled, fenced ```mermaid blocks in doc
markdown are rendered to SVG at build time and inlined into
the emitted HTML; pages ship with finished diagrams and no
client-side mermaid bundle.

### Enabling

Add to `walkthrough.json`:

```json
{
  "mermaid": true
}
```

Or customize:

```json
{
  "mermaid": {
    "theme": "dark",
    "cacheDir": ".cache/mermaid"
  }
}
```

- `theme`: `"default" | "dark" | "neutral" | "forest"` —
  mermaid's built-in themes. Default: `"default"`.
- `cacheDir`: path (relative to `walkthrough.json`'s dir) where
  rendered SVGs are cached. Default: `.cache/mermaid`.

### Peer dependencies

`mermaid` and `puppeteer` are optional peer deps. When you
enable the feature, install them in your project:

```bash
pnpm add -D mermaid puppeteer
```

(`svgo` is already a meander devDep but optionally also
becomes a peer in future versions; installing it doesn't
hurt.)

### How it works

1. Shared puppeteer browser per build — Chromium boot cost paid
   at most once.
2. SHA-256 cache keyed on `mermaid version + theme + source`.
   Unchanged diagrams are a pure disk read.
3. SVGO shrinks each diagram ~30% after render.

### Why build-time

- Zero client JS. No render flash, no layout shift, no waiting
  on a 1MB+ bundle.
- CSP stays tight. No extra `script-src` entry.
- Works offline, works with tight network, works under strict
  CSP.

## Pluggable inline-code tokenizer

Consumers can register custom classifier + tokenizer pairs
for inline `<code>` spans in prose. First matcher wins;
unmatched spans fall through to `hljs.highlight(text, {
language: "typescript" })` as the default fallback.

### Registering a tokenizer

Push entries into the array at
`window[Symbol.for("meander:inline-tokenizers")]` from any
script on the page (before or after meander's bundle — the
array is a stable symbol-keyed handle either way):

```js
const reg = (window[Symbol.for("meander:inline-tokenizers")] ??= []);
reg.push({
  name: "purl",
  classify: (text) => /^pkg:[a-z]+\//.test(text),
  tokenize: (text) => {
    /* return escaped HTML; meander sets it via innerHTML */
    return `<span class="hljs-keyword">${text.slice(0, 3)}</span>` +
           escape(text.slice(3));
  },
});
```

Each entry:

- `name` (optional): debug label; shows up in
  `data-mdr-tokenized` on the processed element.
- `classify(text)`: returns truthy if this tokenizer owns the
  span.
- `tokenize(text)`: returns HTML string. Assigned via
  `innerHTML` — escape untrusted content yourself.

### Scope

The pass runs against every inline `<code>` inside
`.annotation-md`, `.doc-content`, or `.mdr-hero-desc` that
isn't already inside a `<pre>`. Block code (fenced code) is
left alone — hljs already highlights those at the block
level.

### Idempotency

After processing, each `<code>` gets a `data-mdr-tokenized`
attribute whose value is the winning tokenizer's `name` (or
`"hljs"` for the fallback). Subsequent passes skip tagged
elements.

### Runs after hljs

The tokenizer pass is gated on `onHljsReady`, so tokenizers
that delegate to `hljs.highlight()` get the grammar they
need. On pages without any `.line-code` blocks, `onHljsReady`
resolves immediately.

## Footer

**On by default.** Every page renders a small attribution
footer at the bottom ("Built with meander" → upstream repo).

### Opt out

```json
{
  "footer": false
}
```

### Customize

```json
{
  "footer": {
    "text": "© 2026 My Company",
    "href": "https://example.com"
  }
}
```

## Index page — hero panel + TOC card grid

The index page now renders as a card grid of parts rather than
a plain `<ul>`. Each card shows:

- Part number + optional size-tier badge on the top row.
- Part title.
- The part's `objective` field as the card description.
- Section count at the bottom.

Docs (when present) get their own card at the end of the grid.

### Optional hero panel

```json
{
  "hero": {
    "subtitle": "A walkthrough of the package-url/purl-spec implementation",
    "description": "Inline **markdown** is supported, including `code` and [links](https://example.com)."
  }
}
```

- `subtitle`: short tagline shown beneath the title. Plain
  text.
- `description`: one-paragraph intro. Renders inline markdown
  (bold, italic, code, links).

Both are optional; omit the whole `hero` key to skip the panel.

### Layout

The grid uses `grid-template-columns: repeat(auto-fill,
minmax(280px, 1fr))`, so cards reflow from multi-column on
wide viewports to single-column on mobile without a separate
media-query branch.

## Size-tier badges on the index

**Opt-in.** When enabled, each part on the index page gets a
t-shirt-size badge (`x-small` / `small` / `medium` / `large` /
`x-large`) based on its total code-line count across every
section:

| Badge   | Total code lines |
| ------- | ---------------- |
| x-small | ≤ 100            |
| small   | ≤ 400            |
| medium  | ≤ 1000           |
| large   | ≤ 2500           |
| x-large | > 2500           |

### Enabling

```json
{
  "sizeTiers": true
}
```

Each badge gets both a generic `.mdr-size-tier` class and a
tier-specific `.mdr-size-tier-<tier>` class so consumers can
re-theme them.

## Doc entries — rich form with `filename`, `title`, `summary`

Docs can be either a plain path string (shorthand) or an object
with extra metadata:

```json
{
  "documents": [
    "docs/api.md",
    {
      "source": "docs/README.md",
      "filename": "readme",
      "title": "Overview",
      "summary": "Start here"
    }
  ]
}
```

Fields:
- `source` (required): path to the markdown file, relative to
  `walkthrough.json`.
- `filename` (optional): URL-friendly slug. When set, links in
  `llms.txt` point at `/slug/docs/<filename>` instead of the
  legacy `#anchor` form on the combined documents page. Must be
  `[a-z0-9][a-z0-9-]*` and unique across all parts + docs.
- `title` (optional): overrides the default doc title (which
  otherwise falls back to the filename). Used by `llms.txt` and
  future nav surfaces.
- `summary` (optional): one-line description shown in
  `llms.txt` next to the link.

String shorthand (`"docs/foo.md"`) remains supported and
equivalent to `{ source: "docs/foo.md" }`.

## Clean part URLs via `filename`

**Opt-in, per-part.** Adding a `filename` field to a part
shifts its URL from `/<slug>/part/<id>` to
`/<slug>/parts/<filename>`. The output lands at
`parts/<filename>.html` in the emit dir.

### Example

```json
{
  "parts": [
    {
      "id": 1,
      "title": "Getting started",
      "filename": "setup",
      "objective": "…",
      "keywords": ["…"],
      "files": ["…"]
    }
  ]
}
```

Rendered as `/test-docs/parts/setup` instead of
`/test-docs/part/1`.

### Rules

- Filenames must match `[a-z0-9][a-z0-9-]*`.
- Filenames must be unique within a walkthrough.
- Parts without a `filename` keep the legacy numeric URL form
  (back-compat — existing consumers see no change).

## llms.txt / llms-full.txt

**Opt-in.** When enabled, meander writes two extra files to
the output dir for LLM agents following the
[llmstxt.org](https://llmstxt.org) convention:

- **llms.txt** — title + parts + docs as a linked markdown
  index. URLs are root-relative by default.
- **llms-full.txt** — the index plus every document's full
  markdown body, separated by `---`. Agents can ingest the
  whole walkthrough in one pass.

### Enabling

```json
{
  "llmsIndex": true
}
```

Or to emit absolute URLs (useful when the walkthrough is
served under a canonical origin):

```json
{
  "llmsIndex": {
    "siteUrl": "https://example.com"
  }
}
```

## Service worker (offline cache)

**Opt-in.** When enabled, meander writes `sw.js` to the output
root and injects a registration script into every page's
`<head>` so readers get offline replay of whatever they've
visited.

### Enabling

```json
{
  "serviceWorker": true
}
```

Or pin a version string to force all cached clients to upgrade:

```json
{
  "serviceWorker": {
    "version": "2026-04-24-commit-a1b2c3d"
  }
}
```

- `version`: the `CACHE_VERSION` string embedded in the SW.
  Bumping it flips the SW bytes, which triggers the browser's
  update check and causes the `activate` handler to prune the
  old cache. Default: today's date in `YYYYMMDD` form.

### Behavior

- **Cache-first with stale-while-revalidate** for static assets
  (CSS, JS, icons, fonts). Readers get an instant response;
  the background fetch refreshes the cache for next time.
- **Network-first** for HTML navigations. Stale HTML is the
  worst cache-miss mode — the page ships pointing at asset
  URLs that may have moved. Falls back to cache only on
  offline.
- **Bypass** on POST/PUT/DELETE, cross-origin, and `/api/*`
  paths so mutations and APIs always reach the network.

Registration is gated on `location.hostname` not being
`localhost` / `127.0.0.1`, so dev servers don't cache between
reloads.

## Subresource Integrity (SRI)

**Opt-in.** When enabled, every emitted `<script src>` and
`<link rel=stylesheet|preload|modulepreload>` gets an
`integrity="sha512-..."` attribute so browsers reject tampered
responses.

### Enabling

```json
{
  "sri": true
}
```

Or customize:

```json
{
  "sri": {
    "cacheDir": ".cache/sri"
  }
}
```

- `cacheDir`: where to disk-cache hashes of remote URLs.
  Default: `.cache/sri`.

### How it works

- Remote URLs (currently `unpkg.com`, `cdn.jsdelivr.net`) are
  fetched, hashed, and cached on disk. Subsequent builds reuse
  the cache.
- Same-origin refs (`/walkthrough.css`, etc.) are read from the
  output dir and hashed from bytes.
- Remote tags also get `crossorigin="anonymous"` (required for
  SRI to run on cross-origin responses).

Tags that already carry an `integrity=` attribute are left
alone, so hand-authored SRI entries (like the hljs CDN link)
don't double-hash.

## Content-Security-Policy meta

**Opt-in.** When enabled, meander emits a
`<meta http-equiv="Content-Security-Policy">` tag in `<head>`
with per-inline-script/style sha256 hashes so pages load under
strict CSP without `'unsafe-inline'`.

### Enabling

```json
{
  "csp": true
}
```

Or customize:

```json
{
  "csp": {
    "connectSrc": ["https://api.example.com"],
    "cdnHosts": ["https://unpkg.com", "https://cdn.jsdelivr.net"]
  }
}
```

- `connectSrc`: origins your client-side code fetches from
  (beyond the page's own origin). Default: `[]`.
- `cdnHosts`: origins serving `<script src>` / `<link href>`
  CDN URLs. Default: `["https://unpkg.com"]`.

### Directives emitted

```
default-src 'self'
script-src 'self' + cdnHosts + inline-script sha256 hashes
style-src 'self' + cdnHosts + inline-style sha256 hashes + 'unsafe-hashes'
connect-src 'self' + connectSrc
img-src 'self' data:
font-src 'self'
worker-src 'self'
base-uri 'self'
form-action 'self'
frame-ancestors 'none'
```

A page that already has a CSP meta tag is left unchanged.

## Namespace

All client-side modules attach to `window[Symbol.for("meander:pages")]`
(via `assets/boot.js`). Primitives exposed:

- `ns.storageGet(key)` / `ns.storageSet(key, value)` —
  guarded localStorage (no-ops on quota / private mode).
- `ns.onReady(fn)` — run after DOMContentLoaded.
- `ns.onHljsReady(fn)` — run after hljs finishes tokenizing
  the first `.line-code` block.
- `ns.wrapJsdocTags(container)` /
  `ns.groupJsdocBlocks(container)` — exported by the JSDoc
  pipeline modules so custom orchestrators can call them.

## CSS class prefix

Every class added by meander uses the `mdr-` prefix
(short for **m**ean**d**e**r**), chosen to avoid colliding with
consumer styles. Base framework classes (`.topbar`, `.file-block`,
`.code-table`, `.annotation-card`, etc.) keep their plain names
since they're the walkthrough's core structure.
