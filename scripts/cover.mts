/**
 * @fileoverview Coverage runner: runs tests with coverage enabled,
 * filters noise from the raw vitest output, and prints a tidy summary.
 *
 * Options:
 *   --code-only  Run only code coverage (skip type coverage)
 *   --type-only  Run only type coverage (skip code coverage)
 *   --summary    Show only the summary block (hide the per-file table)
 *
 * Modeled after ../socket-packageurl-js/scripts/cover.mts so `pnpm
 * cover` behaves the same across the fleet.
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseArgs } from '@socketsecurity/lib/argv/parse'
import type { Logger } from '@socketsecurity/lib/logger'
import { getDefaultLogger } from '@socketsecurity/lib/logger'
import { printHeader } from '@socketsecurity/lib/stdio/header'

import { errorMessage } from './utils/error-message.mts'
import type { CommandResult } from './utils/run-command.mts'
import { runCommandQuiet } from './utils/run-command.mts'

const logger: Logger = getDefaultLogger()

const __dirname: string = path.dirname(fileURLToPath(import.meta.url))
const rootPath: string = path.join(__dirname, '..')

type CoverValues = {
  'code-only': boolean
  summary: boolean
  'type-only': boolean
}

const { values } = parseArgs({
  options: {
    'code-only': { type: 'boolean', default: false },
    'type-only': { type: 'boolean', default: false },
    summary: { type: 'boolean', default: false },
  },
  strict: false,
  allowPositionals: true,
}) as { values: CoverValues }

printHeader('Test Coverage')
console.log('')

const customFlags: string[] = ['--code-only', '--type-only', '--summary']
const vitestArgs: string[] = [
  'vitest',
  '--config',
  '.config/vitest.config.mts',
  '--run',
  '--coverage',
  ...process.argv.slice(2).filter(arg => !customFlags.includes(arg)),
]
const typeCoverageArgs: string[] = ['exec', 'type-coverage']

const ansiRegex = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function extractTypeCoveragePercent(out: string): number | undefined {
  const m = out.match(/\([\d\s/]+\)\s+([\d.]+)%/)
  return m ? Number.parseFloat(m[1]!) : undefined
}

function extractCodeCoveragePercent(out: string): number | undefined {
  const m = out.match(/All files\s+\|\s+([\d.]+)\s+\|[^\n]*/)
  return m ? Number.parseFloat(m[1]!) : undefined
}

function displayCodeCoverageTable(output: string): void {
  const headerMatch = output.match(
    / % Coverage report from v8\n([-|]+)\n([^\n]+)\n\1/,
  )
  const allFilesMatch = output.match(/All files\s+\|\s+[\d.]+\s+\|[^\n]*/)
  if (headerMatch && allFilesMatch) {
    console.log(' % Coverage report from v8')
    console.log(headerMatch[1])
    console.log(headerMatch[2])
    console.log(headerMatch[1])
    console.log(allFilesMatch[0])
    console.log(headerMatch[1])
    console.log()
  }
}

function displayTestSummary(output: string): void {
  const m = output.match(
    /Test Files\s+\d+[^\n]*\n[\s\S]*?Duration\s+[\d.]+m?s[^\n]*/,
  )
  if (m) {
    console.log()
    console.log(m[0])
    console.log()
  }
}

try {
  await runCommandQuiet('pnpm', ['run', 'build'], { cwd: rootPath })

  let exitCode = 0
  let codeCoverageResult: CommandResult | undefined
  let typeCoverageResult: CommandResult | undefined

  if (values['type-only']) {
    typeCoverageResult = await runCommandQuiet('pnpm', typeCoverageArgs, {
      cwd: rootPath,
    })
    exitCode = typeCoverageResult.exitCode
    const typePct = extractTypeCoveragePercent(
      typeCoverageResult.stdout + typeCoverageResult.stderr,
    )
    if (typePct !== undefined) {
      console.log()
      console.log(' Coverage Summary')
      console.log(' ───────────────────────────────')
      console.log(` Type Coverage: ${typePct.toFixed(2)}%`)
      console.log()
    }
  } else if (values['code-only']) {
    codeCoverageResult = await runCommandQuiet('pnpm', vitestArgs, {
      cwd: rootPath,
      env: { ...process.env, VITEST: '1' },
    })
    exitCode = codeCoverageResult.exitCode
    const output = (codeCoverageResult.stdout + codeCoverageResult.stderr)
      .replace(ansiRegex, '')
      .trim()
    if (!values.summary) {
      displayTestSummary(output)
      displayCodeCoverageTable(output)
    }
    const codePct = extractCodeCoveragePercent(output)
    if (codePct !== undefined) {
      console.log(' Coverage Summary')
      console.log(' ───────────────────────────────')
      console.log(` Code Coverage: ${codePct.toFixed(2)}%`)
      console.log()
    } else if (exitCode !== 0) {
      console.log('\n--- Output ---')
      console.log(output)
    }
  } else {
    codeCoverageResult = await runCommandQuiet('pnpm', vitestArgs, {
      cwd: rootPath,
      env: { ...process.env, VITEST: '1' },
    })
    exitCode = codeCoverageResult.exitCode
    typeCoverageResult = await runCommandQuiet('pnpm', typeCoverageArgs, {
      cwd: rootPath,
    })
    const output = (codeCoverageResult.stdout + codeCoverageResult.stderr)
      .replace(ansiRegex, '')
      .trim()
    if (!values.summary) {
      displayTestSummary(output)
      displayCodeCoverageTable(output)
    }
    const codePct = extractCodeCoveragePercent(output)
    const typePct = extractTypeCoveragePercent(
      typeCoverageResult.stdout + typeCoverageResult.stderr,
    )
    if (codePct !== undefined) {
      console.log(' Coverage Summary')
      console.log(' ───────────────────────────────')
      if (typePct !== undefined) {
        console.log(` Type Coverage: ${typePct.toFixed(2)}%`)
      }
      console.log(` Code Coverage: ${codePct.toFixed(2)}%`)
      if (typePct !== undefined) {
        const cumulative = ((codePct + typePct) / 2).toFixed(2)
        console.log(' ───────────────────────────────')
        console.log(` Cumulative:    ${cumulative}%`)
      }
      console.log()
    } else if (exitCode !== 0) {
      console.log('\n--- Output ---')
      console.log(output)
    }
  }

  if (exitCode === 0) {
    logger.success('Coverage completed successfully')
  } else {
    logger.error('Coverage failed')
  }
  process.exitCode = exitCode
} catch (e) {
  logger.error(`Coverage script failed: ${errorMessage(e)}`)
  process.exitCode = 1
}
