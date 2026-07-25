/*
 * @file Build runner: bundles the CLI via rolldown + emits
 *   type declarations via tsc.
 *   Two outputs:
 *   dist/cli.mjs      single-file bundle, consumer-install entry.
 *   dist .d.mts files type declarations for programmatic consumers
 *   (`import { generate } from '@socketsecurity/meander'`).
 *   Types come from `tsc --emitDeclarationOnly`; the bundle itself
 *   is pure JS via rolldown's native TS transform.
 *   Externals:
 *
 *   - node built-ins (never bundled).
 *   - esbuild / mermaid / puppeteer / svgo — loaded dynamically by opt-in
 *     features. Bundling them would drag in Chromium downloads (puppeteer) or
 *     force mermaid's DOM-heavy runtime into the CLI for everyone. Consumers
 *     install them only if they enable minify / mermaid / svg-opt.
 *   - @valtown/sdk — only used by deploy-val. Kept external so the CLI stays
 *     small for the 90% of users who only run generate / serve / publish.
 */

import { builtinModules } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import type { Logger } from '@socketsecurity/lib-stable/logger/logger'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { build } from 'rolldown'

import { errorMessage } from './utils/error-message.mts'
import { runCommand } from './utils/run-command.mts'

const logger: Logger = getDefaultLogger()

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootPath = path.join(scriptDir, '..', '..')
const distPath = path.join(rootPath, 'dist')

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
]

/**
 * Optional + deploy-only deps. Never bundled.
 */
export const runtimeExternals = [
  '@valtown/sdk',
  'esbuild',
  'mermaid',
  'puppeteer',
  'svgo',
]

export async function main(): Promise<void> {
  await safeDelete(distPath, { recursive: true, force: true })

  logger.log('→ bundling dist/cli.mjs (rolldown)')
  await build({
    external: [...nodeBuiltins, ...runtimeExternals],
    input: path.join(rootPath, 'src/cli.mts'),
    output: {
      banner: '#!/usr/bin/env node',
      // Internal dynamic imports fold into the single-file bundle
      // (external opt-in deps stay dynamic at runtime).
      codeSplitting: false,
      file: path.join(distPath, 'cli.mjs'),
      format: 'esm',
      minify: false,
      sourcemap: false,
    },
    platform: 'node',
  })

  logger.log('→ emitting .d.mts declarations (tsc)')
  const tscCode = await runCommand(
    'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.build.json'],
    { cwd: rootPath },
  )
  if (tscCode !== 0) {
    process.exitCode = tscCode
    return
  }

  logger.success('build complete')
}

main().catch(e => {
  logger.error(`Build failed: ${errorMessage(e)}`)
  process.exitCode = 1
})
