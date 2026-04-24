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

## Theme toggle (system / light / dark)

A 30×30 icon in `.topbar-actions` opens a menu with three
choices. The pick persists to `localStorage` under
`meander:pages:theme`; a stored value resolves synchronously in
`<head>` before first paint, so dark-preferring systems never
flash the light theme.

The three SVG icons stack on top of each other via
`position: absolute; inset: 0; margin: auto`, so switching
preference only flips opacity — the button never reflows.

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
