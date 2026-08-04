/**
 * @file Rolldown configuration for the meander CLI bundle — one
 *   real bundle, `dist/cli.mjs`, the consumer-install entry
 *   (see package.json `bin`). `scripts/repo/build.mts` imports
 *   this config and calls rolldown's `build()` with it; type
 *   declarations are emitted separately via `tsc`.
 *   Externals:
 *
 *   - node built-ins (never bundled).
 *   - lightningcss / mermaid / puppeteer / rolldown / svgo — loaded dynamically
 *     by opt-in features. Bundling them would drag in Chromium downloads
 *     (puppeteer) or force mermaid's DOM-heavy runtime into the CLI for
 *     everyone. Consumers install `rolldown` themselves only if they enable the
 *     JS minify pass; `lightningcss` and `svgo` ship as direct meander deps but
 *     stay external so their (larger) parser code isn't duplicated into cli.mjs
 *     — lightningcss is also a native napi module, so bundling it would break
 *     its own binary resolution the same way a bundled `rolldown/experimental`
 *     would.
 *   - @valtown/sdk — only used by deploy-val. Kept external so the CLI stays
 *     small for the 90% of users who only run generate / serve / publish.
 */

import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BuildOptions } from 'rolldown'

const configDir = path.dirname(fileURLToPath(import.meta.url))
const rootPath = path.join(configDir, '..', '..')

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]

/**
 * Optional + deploy-only deps. Never bundled.
 */
export const runtimeExternals = [
  '@valtown/sdk',
  'lightningcss',
  'mermaid',
  'puppeteer',
  'rolldown',
  'svgo',
]

/* `external` string entries match the import specifier EXACTLY — a bare
 * 'rolldown' entry does not cover src/minify.mts's `import('rolldown/
 * experimental')`. Bundling that subpath would inline rolldown's own napi
 * loader into cli.mjs, where its binary-lookup paths (resolved relative to
 * rolldown's own package dir) no longer point anywhere real. The regex
 * externalizes every 'rolldown' + 'rolldown/<subpath>' specifier so the
 * whole package stays a real runtime import. */
const rolldownSpecifier = /^rolldown(?:\/|$)/

export const cliBuildConfig: BuildOptions = {
  external: [...nodeBuiltins, ...runtimeExternals, rolldownSpecifier],
  input: path.join(rootPath, 'src/cli.mts'),
  output: {
    banner: '#!/usr/bin/env node',
    // Internal dynamic imports fold into the single-file bundle
    // (external opt-in deps stay dynamic at runtime).
    codeSplitting: false,
    file: path.join(rootPath, 'dist/cli.mjs'),
    format: 'esm',
    minify: false,
    sourcemap: false,
  },
  platform: 'node',
}
