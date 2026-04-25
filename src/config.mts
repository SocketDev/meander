/**
 * Unified meander config. A single JSON file (conventionally
 * `meander.config.json`) holds everything: the walkthrough content
 * (slug, title, parts, documents) and the infra/runtime knobs
 * (comments, theme, styles, demoMode, outDir, csp, sri, mermaid,
 * ...). Accept any filename — the CLI passes the path explicitly.
 *
 * Design principle: **opt out = skip emission**. When a consumer
 * sets `comments: false`, meander must not inline the comment JS,
 * must not emit comment CSS, must not plant the indicator DOM.
 * Post-processing the feature away is the anti-pattern we're
 * actively retreating from.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

/* ------------------------------------------------------------------ */
/*  Content sub-schemas                                                */
/* ------------------------------------------------------------------ */

export const WalkthroughPartSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1 }),
  objective: Type.String({ minLength: 1 }),
  keywords: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  /**
   * Optional URL-friendly slug. When set, the part is emitted
   * to /<slug>/parts/<filename>.html instead of
   * /<slug>/part/<id>.html, giving readers a stable,
   * human-readable URL. Must be [a-z0-9][a-z0-9-]* and unique
   * within the walkthrough.
   */
  filename: Type.Optional(
    Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$', minLength: 1 }),
  ),
})

/**
 * Favicon override. Consumers can disable entirely (`false`),
 * omit to get meander's default bezel-derived favicon, or
 * provide their own assets.
 *
 * When provided, keys are resolved relative to the config file
 * and copied into the output dir at the corresponding
 * `/favicon-*` paths. Omitted keys fall back to the meander
 * defaults for that size.
 */
export const FaviconSchema = Type.Union([
  Type.Literal(false),
  Type.Object({
    svg: Type.Optional(Type.String({ minLength: 1 })),
    ico: Type.Optional(Type.String({ minLength: 1 })),
    png: Type.Optional(
      Type.Object({
        '16': Type.Optional(Type.String({ minLength: 1 })),
        '32': Type.Optional(Type.String({ minLength: 1 })),
        '48': Type.Optional(Type.String({ minLength: 1 })),
        '180': Type.Optional(Type.String({ minLength: 1 })),
      }),
    ),
    themeColor: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1 }),
        Type.Object({
          light: Type.String({ minLength: 1 }),
          dark: Type.String({ minLength: 1 }),
        }),
      ]),
    ),
  }),
])

/**
 * Doc entry. Shorthand `"path/to/file.md"` is equivalent to
 * `{ source: "path/to/file.md" }`. Full object form supports
 * optional `filename` (enables /slug/docs/<filename> URLs
 * in llms.txt), `title` (override for link labels; defaults
 * to the markdown file's h1 or basename), and `summary`
 * (shown in llms.txt alongside the link).
 */
export const DocEntrySchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Object({
    source: Type.String({ minLength: 1 }),
    filename: Type.Optional(
      Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$', minLength: 1 }),
    ),
    title: Type.Optional(Type.String({ minLength: 1 })),
    summary: Type.Optional(Type.String({ minLength: 1 })),
  }),
])

/* ------------------------------------------------------------------ */
/*  Opt-out sub-schemas                                                */
/* ------------------------------------------------------------------ */

/**
 * Comments config. Accepts three shapes:
 *
 *   false          — no comment JS, no comment CSS, no DOM hooks
 *   true (default) — batteries-included: meander's UI + backend
 *                    wiring, default styles, meander-owned
 *                    comment-client
 *   object         — fine-grained control per field
 *
 * Object fields:
 *   enabled           Top-level kill switch. Overrides everything
 *                     else when false.
 *   ui                When false, comment-client.js is not inlined.
 *                     Use when shipping your own UI that talks to
 *                     the same backend API.
 *   styles            When false, comment CSS is not emitted.
 *                     Use when your UI owns the visual layer.
 *   backend           Absolute URL of the comment backend. Omit
 *                     when the HTML is hosted same-origin as the
 *                     backend (default Val Town deploy).
 *   allowedEmailDomains
 *                     Gating for writes. Empty (or absent) means
 *                     the backend refuses writes entirely — the
 *                     safe default. Set to ["gmail.com"] or
 *                     similar to open writes to those domains.
 *   seedPath          Path to a JSON file of seed comments,
 *                     relative to the config file. Rendered at
 *                     build time; used for both demo mode and
 *                     pre-seeded deploys.
 */
const CommentsConfigSchema = Type.Union([
  Type.Boolean(),
  Type.Object({
    enabled: Type.Optional(Type.Boolean()),
    ui: Type.Optional(Type.Boolean()),
    styles: Type.Optional(Type.Boolean()),
    backend: Type.Optional(Type.String({ minLength: 1 })),
    allowedEmailDomains: Type.Optional(
      Type.Array(Type.String({ minLength: 1 })),
    ),
    seedPath: Type.Optional(Type.String({ minLength: 1 })),
  }),
])

/**
 * Theme toggle config. `false` drops theme.js + theme-toggle
 * styles entirely (page ships pinned to the CSS `:root` palette,
 * no toggle widget). `true` or absent = default stack
 * (system/light/dark/neo-kiju).
 */
const ThemeConfigSchema = Type.Union([
  Type.Boolean(),
  Type.Object({
    themes: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal('system'),
          Type.Literal('light'),
          Type.Literal('dark'),
          Type.Literal('neo-kiju'),
        ]),
      ),
    ),
  }),
])

/**
 * Stylesheet emission.
 *
 *   false     — meander.css is NOT linked from emitted HTML.
 *               Consumer owns the visual layer end-to-end; bring
 *               your own <link rel="stylesheet"> in headExtra or
 *               equivalent.
 *   true      — meander.css ships as today (default).
 *   object    — per-bucket flags reserved for a future pass. The
 *               buckets (base/theme/ui/comments/prose) are listed
 *               in the schema so config files can stabilize their
 *               shape now, but today the emitter only honors the
 *               top-level boolean. Consumers who really need
 *               partial drops can set `styles: false` and bring a
 *               hand-tailored subset of the source.
 */
const StylesConfigSchema = Type.Union([
  Type.Boolean(),
  Type.Object({
    base: Type.Optional(Type.Boolean()),
    theme: Type.Optional(Type.Boolean()),
    ui: Type.Optional(Type.Boolean()),
    comments: Type.Optional(Type.Boolean()),
    prose: Type.Optional(Type.Boolean()),
  }),
])

/* ------------------------------------------------------------------ */
/*  Top-level schema                                                   */
/* ------------------------------------------------------------------ */

/**
 * One config file to rule them all. Content fields (slug, title,
 * parts, documents) come first; infra/runtime toggles follow.
 * Everything past `parts` is optional — a minimal config just
 * lists content.
 */
export const MeanderConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),

  /* ---------------- content ---------------- */

  slug: Type.String({ minLength: 1, pattern: '^[a-z0-9][a-z0-9-]*$' }),
  title: Type.String({ minLength: 1 }),
  documents: Type.Optional(Type.Array(DocEntrySchema, { minItems: 1 })),
  parts: Type.Array(WalkthroughPartSchema, { minItems: 1 }),

  /* ---------------- opt-out surface ---------------- */

  comments: Type.Optional(CommentsConfigSchema),
  theme: Type.Optional(ThemeConfigSchema),
  styles: Type.Optional(StylesConfigSchema),

  /**
   * Demo mode: comments render in read-only state with a banner.
   * Loads seed comments from `comments.seedPath` if set. Disables
   * composer submission. Shows a dismissible banner explaining
   * "comments are ephemeral in this demo."
   */
  demoMode: Type.Optional(Type.Boolean()),

  /**
   * Directory name meander emits into, relative to the config
   * file's dir. Default: `"pages"`. Used by:
   *   - generate (local emit: <rootDir>/<outDir>/...)
   *   - serve (reads from the same dir)
   *   - publish (Val Town blob key prefix: <outDir>/<slug>/...)
   *   - deploy-val (passes it to the val as MEANDER_OUT_DIR so
   *     the val serves from the same blob prefix)
   *
   * Changing this for an existing deployment requires a
   * republish — old blob keys stay under the previous prefix.
   */
  outDir: Type.Optional(
    Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$', minLength: 1 }),
  ),

  /**
   * When `true`, `meander publish` envelope-encrypts each
   * walkthrough HTML blob before uploading to Val Town:
   *
   *   1. Generates a random per-blob data key (DEK).
   *   2. Encrypts the HTML with that DEK (AES-256-GCM).
   *   3. Wraps the DEK with the operator's `MEANDER_BLOB_KEY`.
   *   4. Uploads `ENVELOPE:1:<wrappedDEK>:<ciphertext>`.
   *
   * The val recognizes the prefix and decrypts before serving.
   * Plaintext blobs (no prefix) are served as-is — opt-in is
   * by setting this flag *and* having `MEANDER_BLOB_KEY` set on
   * both the publisher and the val.
   *
   * Default: `false`. The common case is GitHub-Pages-served
   * walkthroughs where Val Town hosts only the comments.
   * Set `true` for private-repo projects that publish HTML to
   * Val Town and don't want the prose readable from a cold blob
   * dump.
   */
  encryptBlobs: Type.Optional(Type.Boolean()),

  /* ---------------- page chrome ---------------- */

  /**
   * Favicon override. Default: meander ships its own
   * bezel-derived favicon set (svg + ico + sized pngs). Set
   * `false` to skip emitting any favicon link tags, or
   * provide an object to swap individual assets.
   */
  favicon: Type.Optional(FaviconSchema),

  /**
   * Footer control. Defaults to `true` — meander emits a small
   * attribution footer on every page. Set `false` to omit.
   *
   * Pass an object to customize text / link:
   *   { footer: { text: "Built with meander", href: "https://..." } }
   */
  footer: Type.Optional(
    Type.Union([
      Type.Boolean(),
      Type.Object({
        text: Type.Optional(Type.String({ minLength: 1 })),
        href: Type.Optional(Type.String({ minLength: 1 })),
      }),
    ]),
  ),

  /**
   * Optional hero panel content for the index page. Renders
   * above the parts TOC.
   *   - subtitle: a tagline shown beneath the site title.
   *   - description: a paragraph of intro copy (supports inline
   *     markdown — bold, italic, code, links).
   */
  hero: Type.Optional(
    Type.Object({
      subtitle: Type.Optional(Type.String({ minLength: 1 })),
      description: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ),

  /* ---------------- build-time features ---------------- */

  /**
   * Minify emitted assets — shrinks inline <script> bodies via
   * esbuild, inline <svg> elements via SVGO, and the standalone
   * meander.css + sw.js files.
   *
   * Default: false.
   *
   * Pass `true` for defaults (all three kinds), or an object
   * to selectively enable:
   *   { minify: { js: true, svg: false, css: true } }
   */
  minify: Type.Optional(
    Type.Union([
      Type.Boolean(),
      Type.Object({
        js: Type.Optional(Type.Boolean()),
        svg: Type.Optional(Type.Boolean()),
        css: Type.Optional(Type.Boolean()),
      }),
    ]),
  ),

  /**
   * Emit size-tier badges on the index TOC so readers can see
   * at a glance which parts are large vs. small.
   */
  sizeTiers: Type.Optional(Type.Boolean()),

  /**
   * Emit llms.txt + llms-full.txt for LLM agents following the
   * llmstxt.org convention.
   */
  llmsIndex: Type.Optional(
    Type.Union([
      Type.Boolean(),
      Type.Object({
        siteUrl: Type.Optional(Type.String({ minLength: 1 })),
      }),
    ]),
  ),

  /**
   * Register a service worker for offline cache + cross-deploy
   * replay. Cache-first for static assets, network-first for
   * HTML navigation.
   */
  serviceWorker: Type.Optional(
    Type.Union([
      Type.Boolean(),
      Type.Object({
        version: Type.Optional(Type.String({ minLength: 1 })),
      }),
    ]),
  ),

  /**
   * Inject Subresource Integrity (SRI) hashes on <script src>
   * and <link rel=stylesheet|preload|modulepreload>, so
   * tampered CDN or origin responses are rejected by the
   * browser.
   */
  sri: Type.Optional(
    Type.Union([
      Type.Boolean(),
      Type.Object({
        cacheDir: Type.Optional(Type.String({ minLength: 1 })),
      }),
    ]),
  ),

  /**
   * Emit a Content-Security-Policy <meta> tag with per-inline-
   * script + per-inline-style hashes so the page loads under a
   * tight CSP without 'unsafe-inline'.
   */
  csp: Type.Optional(
    Type.Union([
      Type.Boolean(),
      Type.Object({
        connectSrc: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        cdnHosts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      }),
    ]),
  ),

  /**
   * Pre-render ```mermaid fenced code blocks in docs to SVG at
   * build time so pages ship with finished diagrams and no
   * client-side mermaid bundle.
   *
   * Requires `mermaid`, `puppeteer`, and `svgo` as peer deps.
   */
  mermaid: Type.Optional(
    Type.Union([
      Type.Boolean(),
      Type.Object({
        theme: Type.Optional(
          Type.Union([
            Type.Literal('default'),
            Type.Literal('dark'),
            Type.Literal('neutral'),
            Type.Literal('forest'),
          ]),
        ),
        cacheDir: Type.Optional(Type.String({ minLength: 1 })),
      }),
    ]),
  ),
})

export type MeanderConfig = Static<typeof MeanderConfigSchema>
export type WalkthroughPart = Static<typeof WalkthroughPartSchema>
export type FaviconConfig = Static<typeof FaviconSchema>
export type DocEntry = Static<typeof DocEntrySchema>

/* ------------------------------------------------------------------ */
/*  Resolved opt-outs (fully-defaulted shape the emitter reads)        */
/* ------------------------------------------------------------------ */

/**
 * The opt-out fields, collapsed to a fully-defaulted shape so
 * every render path can read them without re-applying defaults.
 * Non-opt-out fields (slug, title, parts, ...) live on the raw
 * MeanderConfig and are consumed directly by callers.
 */
export type ResolvedOptOuts = {
  comments: {
    enabled: boolean
    ui: boolean
    styles: boolean
    backend: string | undefined
    allowedEmailDomains: readonly string[]
    seedPath: string | undefined
  }
  theme: {
    enabled: boolean
    themes: ReadonlyArray<'system' | 'light' | 'dark' | 'neo-kiju'>
  }
  styles: {
    base: boolean
    theme: boolean
    ui: boolean
    comments: boolean
    prose: boolean
  }
  demoMode: boolean
  /** Directory for emitted output, default "pages". Also the
   *  blob-key prefix on Val Town. */
  outDir: string
}

const DEFAULT_THEMES = ['system', 'light', 'dark', 'neo-kiju'] as const

function resolveComments(
  input: MeanderConfig['comments'],
): ResolvedOptOuts['comments'] {
  if (input === false) {
    return {
      enabled: false,
      ui: false,
      styles: false,
      backend: undefined,
      allowedEmailDomains: [],
      seedPath: undefined,
    }
  }
  /* Absent or `true` → defaults on. Object → per-field. */
  const obj = typeof input === 'object' && input !== null ? input : {}
  const enabled = obj.enabled ?? true
  return {
    enabled,
    ui: enabled ? (obj.ui ?? true) : false,
    styles: enabled ? (obj.styles ?? true) : false,
    backend: obj.backend,
    allowedEmailDomains: obj.allowedEmailDomains ?? [],
    seedPath: obj.seedPath,
  }
}

function resolveTheme(input: MeanderConfig['theme']): ResolvedOptOuts['theme'] {
  if (input === false) {
    return { enabled: false, themes: [] }
  }
  const obj = typeof input === 'object' && input !== null ? input : {}
  return {
    enabled: true,
    themes: obj.themes ?? DEFAULT_THEMES,
  }
}

function resolveStyles(
  input: MeanderConfig['styles'],
  commentsEnabled: boolean,
): ResolvedOptOuts['styles'] {
  if (input === false) {
    return {
      base: false,
      theme: false,
      ui: false,
      comments: false,
      prose: false,
    }
  }
  const obj = typeof input === 'object' && input !== null ? input : {}
  return {
    base: obj.base ?? true,
    theme: obj.theme ?? true,
    ui: obj.ui ?? true,
    /* Comments CSS auto-follows comments.enabled unless the
     * consumer explicitly overrides. */
    comments: obj.comments ?? commentsEnabled,
    prose: obj.prose ?? true,
  }
}

export function resolveOptOuts(config: MeanderConfig): ResolvedOptOuts {
  const comments = resolveComments(config.comments)
  return {
    comments,
    theme: resolveTheme(config.theme),
    styles: resolveStyles(config.styles, comments.enabled),
    demoMode: config.demoMode ?? false,
    outDir: config.outDir ?? 'pages',
  }
}

/* ------------------------------------------------------------------ */
/*  Loader                                                             */
/* ------------------------------------------------------------------ */

/**
 * Cross-check filename uniqueness. The schema's regex enforces
 * the per-field shape ([a-z0-9][a-z0-9-]*), but "no two sources
 * share a filename" has to be cross-checked across the whole
 * config. Parts + docs share the same namespace — different
 * subdirs, but a shared filename would still be confusing.
 */
function checkFilenameUniqueness(
  configPath: string,
  config: MeanderConfig,
): void {
  const seen = new Map<string, string>()
  for (const part of config.parts) {
    const fn = part.filename
    if (!fn) {
      continue
    }
    const prev = seen.get(fn)
    if (prev !== undefined) {
      throw new Error(
        `${configPath}: filename "${fn}" is used by both ${prev} and part ${part.id}. Filenames must be unique across parts and docs.`,
      )
    }
    seen.set(fn, `part ${part.id}`)
  }
  if (config.documents) {
    for (const d of config.documents) {
      if (typeof d === 'string') {
        continue
      }
      const fn = d.filename
      if (!fn) {
        continue
      }
      const prev = seen.get(fn)
      if (prev !== undefined) {
        throw new Error(
          `${configPath}: filename "${fn}" is used by both ${prev} and doc "${d.source}". Filenames must be unique across parts and docs.`,
        )
      }
      seen.set(fn, `doc "${d.source}"`)
    }
  }
}

/**
 * Load + validate the meander config at the given file path.
 * Returns both the raw config (for content fields — slug, title,
 * parts, documents, etc.) and a resolved opt-outs view with
 * every toggleable field fully-defaulted.
 */
export function loadMeanderConfig(configPath: string): {
  config: MeanderConfig
  resolved: ResolvedOptOuts
} {
  const resolved = path.resolve(configPath)
  const raw: unknown = JSON.parse(readFileSync(resolved, 'utf-8'))
  if (!Value.Check(MeanderConfigSchema, raw)) {
    const errors = [...Value.Errors(MeanderConfigSchema, raw)]
    const messages = errors
      .map(e => `  ${e.path || '(root)'}: ${e.message}`)
      .join('\n')
    throw new Error(`Invalid meander config at ${resolved}:\n${messages}`)
  }
  checkFilenameUniqueness(resolved, raw)
  return { config: raw, resolved: resolveOptOuts(raw) }
}
