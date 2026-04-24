/**
 * @fileoverview Lightweight test runner: delegates to vitest with
 * the shared config. Forwards extra argv so `pnpm test foo.test.mts`
 * filters to one file.
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import type { Logger } from '@socketsecurity/lib/logger'
import { getDefaultLogger } from '@socketsecurity/lib/logger'

import { errorMessage } from './utils/error-message.mts'
import { runCommand } from './utils/run-command.mts'

const logger: Logger = getDefaultLogger()

const __dirname: string = path.dirname(fileURLToPath(import.meta.url))
const rootPath: string = path.join(__dirname, '..')

const extraArgs: string[] = process.argv.slice(2)

try {
  const exitCode = await runCommand(
    'pnpm',
    [
      'exec',
      'vitest',
      '--config',
      '.config/vitest.config.mts',
      '--run',
      ...extraArgs,
    ],
    { cwd: rootPath },
  )
  process.exitCode = exitCode
} catch (e) {
  logger.error(`Test script failed: ${errorMessage(e)}`)
  process.exitCode = 1
}
