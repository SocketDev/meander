/*
 * @file Build runner: bundles the CLI via rolldown + emits
 *   type declarations via tsc.
 *   Two outputs:
 *   dist/cli.mjs      single-file bundle, consumer-install entry.
 *   dist .d.mts files type declarations for programmatic consumers
 *   (`import { generate } from '@socketsecurity/meander'`).
 *   Types come from `tsc --emitDeclarationOnly`; the bundle itself
 *   is pure JS via rolldown's native TS transform. The rolldown
 *   input/output/externals config lives in
 *   `.config/repo/rolldown.cli.config.mts` — this runner just wires it
 *   up to `safeDelete` + `tsc`.
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import type { Logger } from '@socketsecurity/lib-stable/logger/logger'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { build } from 'rolldown'

import { cliBuildConfig } from '../../.config/repo/rolldown.cli.config.mts'
import { errorMessage } from './utils/error-message.mts'
import { runCommand } from './utils/run-command.mts'

const logger: Logger = getDefaultLogger()

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootPath = path.join(scriptDir, '..', '..')
const distPath = path.join(rootPath, 'dist')

export async function main(): Promise<void> {
  await safeDelete(distPath, { recursive: true, force: true })

  logger.log('→ bundling dist/cli.mjs (rolldown)')
  await build(cliBuildConfig)

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
