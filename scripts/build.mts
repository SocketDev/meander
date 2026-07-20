/**
 * @file Build runner: bundles the CLI via esbuild + emits
 *   type declarations via tsc.
 *   Two outputs:
 *   dist/cli.mjs      single-file bundle, consumer-install entry.
 *   dist/*.d.mts      type declarations for programmatic consumers
 *   (`import { generate } from '@socketsecurity/meander'`).
 *   Types come from `tsc --emitDeclarationOnly`; the bundle itself
 *   is pure JS + uses esbuild's much faster transform pipeline.
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import type { Logger } from '@socketsecurity/lib-stable/logger/logger'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { build } from 'esbuild'

import { buildConfig } from '../.config/esbuild.config.mjs'
import { errorMessage } from './utils/error-message.mts'
import { runCommand } from './utils/run-command.mts'

const logger: Logger = getDefaultLogger()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootPath = path.join(__dirname, '..')
const distPath = path.join(rootPath, 'dist')

async function main(): Promise<void> {
  await safeDelete(distPath, { recursive: true, force: true })

  logger.log('→ bundling dist/cli.mjs (esbuild)')
  const result = await build(buildConfig)
  if (result.errors.length) {
    for (const e of result.errors) {
      logger.error(e.text)
    }
    process.exitCode = 1
    return
  }

  logger.log('→ emitting .d.mts declarations (tsc)')
  const tscCode = await runCommand(
    'pnpm',
    ['exec', 'tsc', '-p', '.config/tsconfig.build.json'],
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
