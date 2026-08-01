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
 *
 * The TypeBox schema layer lives in `./config-schema.mts` (re-exported
 * below so consumers keep importing everything from `./config.mts`);
 * this file owns the loader + the resolved-opt-out view.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Value } from '@sinclair/typebox/value'

import { MeanderConfigSchema } from './config-schema.mts'
import type { MeanderConfig } from './config-schema.mts'

export {
  DocEntrySchema,
  FaviconSchema,
  MarkerKindSchema,
  MeanderConfigSchema,
  WalkthroughPartSchema,
} from './config-schema.mts'
export type {
  DocEntry,
  FaviconConfig,
  MeanderConfig,
  WalkthroughPart,
} from './config-schema.mts'

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
  /**
   * Directory for emitted output, default "pages". Also the
   * blob-key prefix on Val Town.
   */
  outDir: string
}

const DEFAULT_THEMES = ['system', 'light', 'dark', 'neo-kiju'] as const

/**
 * Cross-check filename uniqueness. The schema's regex enforces
 * the per-field shape ([a-z0-9][a-z0-9-]*), but "no two sources
 * share a filename" has to be cross-checked across the whole
 * config. Parts + docs share the same namespace — different
 * subdirs, but a shared filename would still be confusing.
 */
export function checkFilenameUniqueness(
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

export function resolveComments(
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

export function resolveOptOuts(config: MeanderConfig): ResolvedOptOuts {
  const comments = resolveComments(config.comments)
  return {
    comments,
    theme: resolveTheme(config.theme),
    styles: resolveStyles(config.styles, { commentsEnabled: comments.enabled }),
    demoMode: config.demoMode ?? false,
    outDir: config.outDir ?? 'pages',
  }
}

export function resolveStyles(
  input: MeanderConfig['styles'],
  config: { commentsEnabled: boolean },
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
  const { commentsEnabled } = { __proto__: null, ...config } as typeof config
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

export function resolveTheme(
  input: MeanderConfig['theme'],
): ResolvedOptOuts['theme'] {
  if (input === false) {
    return { enabled: false, themes: [] }
  }
  const obj = typeof input === 'object' && input !== null ? input : {}
  return {
    enabled: true,
    themes: obj.themes ?? DEFAULT_THEMES,
  }
}
