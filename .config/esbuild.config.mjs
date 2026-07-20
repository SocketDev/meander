/**
 * @file Esbuild build config for meander.
 *   Produces a single-file `dist/cli.mjs` so consumers who install
 *   `@socketsecurity/meander` get a self-contained CLI — no transitive
 *   node_modules scan required at runtime.
 *   Externals:
 *
 *   - node:* built-ins (never bundled).
 *   - esbuild / mermaid / puppeteer / svgo — loaded dynamically by opt-in
 *     features. Bundling them would drag in Chromium downloads (puppeteer) or
 *     force mermaid's DOM-heavy runtime into the CLI for everyone. Consumers
 *     install them only if they enable minify / mermaid / svg-opt.
 *   - @valtown/sdk — only used by deploy-val. Kept external so the CLI stays
 *     small for the 90% of users who only run generate / serve / publish.
 */

import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootPath = path.join(__dirname, '..')

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]

/**
 * Optional + deploy-only deps. Never bundled.
 */
const runtimeExternals = [
  'esbuild',
  'mermaid',
  'puppeteer',
  'svgo',
  '@valtown/sdk',
]

/**
 * @type {import('esbuild').BuildOptions}
 */
export const buildConfig = {
  banner: {
    js: '#!/usr/bin/env node',
  },
  bundle: true,
  entryPoints: [path.join(rootPath, 'src/cli.mts')],
  external: [...nodeBuiltins, ...runtimeExternals],
  format: 'esm',
  logLevel: 'info',
  minify: false,
  outfile: path.join(rootPath, 'dist/cli.mjs'),
  platform: 'node',
  sourcemap: false,
  target: 'node20',
  treeShaking: true,
}
