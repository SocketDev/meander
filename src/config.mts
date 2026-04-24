/**
 * Meander runtime config — the opt-out surface.
 *
 * Two config files ship in every meander project:
 *
 *   1. walkthrough.json — content. Parts, documents, slug, title,
 *      hero. The thing a walkthrough author edits most.
 *
 *   2. .meander.config.json — infrastructure + runtime behavior.
 *      Comments, theme toggle, stylesheets to emit, mermaid,
 *      csp, sri, minify, service worker, llms.txt, size tiers.
 *      The thing a maintainer tunes once and mostly forgets.
 *
 * Phase 1 (this file): define .meander.config.json and its
 * loader. Existing walkthrough.json fields that belong in the
 * infra bucket stay where they are for now — migration is
 * Phase 2.
 *
 * The design principle: **opt out = skip emission**. When a
 * consumer sets `comments: false`, meander must not inline the
 * comment JS, must not emit comment CSS, must not plant the
 * indicator DOM. Post-processing the feature away is the anti-
 * pattern we're actively retreating from.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/* ------------------------------------------------------------------ */
/*  Sub-schemas                                                        */
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
 *                     relative to walkthrough.json. Rendered at
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
]);

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
          Type.Literal("system"),
          Type.Literal("light"),
          Type.Literal("dark"),
          Type.Literal("neo-kiju"),
        ]),
      ),
    ),
  }),
]);

/**
 * Stylesheet emission.
 *
 *   false     — walkthrough.css is NOT linked from emitted HTML.
 *               Consumer owns the visual layer end-to-end; bring
 *               your own <link rel="stylesheet"> in headExtra or
 *               equivalent.
 *   true      — walkthrough.css ships as today (default).
 *   object    — per-bucket flags reserved for a future pass. The
 *               buckets (base/theme/ui/comments/prose) are listed
 *               in the schema so config files can stabilize their
 *               shape now, but today the emitter only honors the
 *               top-level boolean. Consumers who really need
 *               partial drops can set `styles: false` and bring a
 *               hand-tailored subset of the source.
 *
 * The buckets map to banner-comment sections in walkthrough.css:
 *   base      — reset, typography, `html,body`, global structural
 *   theme     — CSS custom properties (palette vars per theme)
 *   ui        — splitter, nav-menus, theme-toggle, footer, hero,
 *               neo-kiju bolt animation
 *   comments  — comment indicator dots, composer, thread chrome
 *               (will exist once meander ships its own comment UI)
 *   prose     — annotation pill styling, JSDoc pills, polishers,
 *               size-tier badges
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
]);

/* ------------------------------------------------------------------ */
/*  Top-level schema                                                   */
/* ------------------------------------------------------------------ */

export const MeanderConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
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
});

export type MeanderConfig = Static<typeof MeanderConfigSchema>;

/* ------------------------------------------------------------------ */
/*  Resolved (fully-defaulted) shape                                   */
/* ------------------------------------------------------------------ */

/**
 * The resolved config every render path reads. Every field is
 * required + non-optional so callers never need to re-apply
 * defaults. `resolveMeanderConfig()` collapses the three input
 * forms (absent, boolean, object) into this shape.
 */
export type ResolvedConfig = {
  comments: {
    enabled: boolean;
    ui: boolean;
    styles: boolean;
    backend: string | undefined;
    allowedEmailDomains: readonly string[];
    seedPath: string | undefined;
  };
  theme: {
    enabled: boolean;
    themes: ReadonlyArray<"system" | "light" | "dark" | "neo-kiju">;
  };
  styles: {
    base: boolean;
    theme: boolean;
    ui: boolean;
    comments: boolean;
    prose: boolean;
  };
  demoMode: boolean;
};

const DEFAULT_THEMES = ["system", "light", "dark", "neo-kiju"] as const;

function resolveComments(
  input: MeanderConfig["comments"],
): ResolvedConfig["comments"] {
  if (input === false) {
    return {
      enabled: false,
      ui: false,
      styles: false,
      backend: undefined,
      allowedEmailDomains: [],
      seedPath: undefined,
    };
  }
  /* Absent or `true` → defaults on. Object → per-field. */
  const obj = typeof input === "object" && input !== null ? input : {};
  const enabled = obj.enabled ?? true;
  return {
    enabled,
    ui: enabled ? (obj.ui ?? true) : false,
    styles: enabled ? (obj.styles ?? true) : false,
    backend: obj.backend,
    allowedEmailDomains: obj.allowedEmailDomains ?? [],
    seedPath: obj.seedPath,
  };
}

function resolveTheme(
  input: MeanderConfig["theme"],
): ResolvedConfig["theme"] {
  if (input === false) {
    return { enabled: false, themes: [] };
  }
  const obj = typeof input === "object" && input !== null ? input : {};
  return {
    enabled: true,
    themes: obj.themes ?? DEFAULT_THEMES,
  };
}

function resolveStyles(
  input: MeanderConfig["styles"],
  commentsEnabled: boolean,
): ResolvedConfig["styles"] {
  if (input === false) {
    return {
      base: false,
      theme: false,
      ui: false,
      comments: false,
      prose: false,
    };
  }
  const obj = typeof input === "object" && input !== null ? input : {};
  return {
    base: obj.base ?? true,
    theme: obj.theme ?? true,
    ui: obj.ui ?? true,
    /* Comments CSS auto-follows comments.enabled unless the
     * consumer explicitly overrides. */
    comments: obj.comments ?? commentsEnabled,
    prose: obj.prose ?? true,
  };
}

export function resolveMeanderConfig(
  input: MeanderConfig | undefined,
): ResolvedConfig {
  const comments = resolveComments(input?.comments);
  return {
    comments,
    theme: resolveTheme(input?.theme),
    styles: resolveStyles(input?.styles, comments.enabled),
    demoMode: input?.demoMode ?? false,
  };
}

/* ------------------------------------------------------------------ */
/*  Loader                                                             */
/* ------------------------------------------------------------------ */

/**
 * Load + validate .meander.config.json from the given directory.
 * Returns the resolved (fully-defaulted) config. If the file
 * doesn't exist, returns defaults — the file is strictly
 * optional.
 *
 * Filename search order (first match wins):
 *   1. .meander.config.json  (dotfile convention, most expected)
 *   2. meander.config.json   (non-dotfile fallback for tools that
 *                             don't show dotfiles by default)
 */
export function loadMeanderConfig(rootDir: string): ResolvedConfig {
  const candidates = [".meander.config.json", "meander.config.json"];
  for (const name of candidates) {
    const candidatePath = path.join(rootDir, name);
    if (!existsSync(candidatePath)) {
      continue;
    }
    const raw: unknown = JSON.parse(readFileSync(candidatePath, "utf-8"));
    if (!Value.Check(MeanderConfigSchema, raw)) {
      const errors = [...Value.Errors(MeanderConfigSchema, raw)];
      const messages = errors
        .map((e) => `  ${e.path || "(root)"}: ${e.message}`)
        .join("\n");
      throw new Error(
        `Invalid ${name} at ${candidatePath}:\n${messages}`,
      );
    }
    return resolveMeanderConfig(raw);
  }
  /* No config file found — every consumer who writes zero
   * config gets the batteries-included defaults. */
  return resolveMeanderConfig(undefined);
}
