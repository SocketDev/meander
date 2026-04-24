/**
 * Clean: remove build output + dev fixture artifacts. `pnpm
 * clean` is non-destructive (no source edits), safe to run
 * anytime.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { safeDelete } from '@socketsecurity/lib/fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const targets = [
  'dist',
  'coverage',
  '.cache',
  'test/fixtures/test-docs/pages',
  'test/fixtures/test-docs/walkthrough',
]
for (const t of targets) {
  const full = path.join(repoRoot, t)
  // eslint-disable-next-line no-await-in-loop -- serial cleanup is intentional; small list
  await safeDelete(full, { recursive: true, force: true })
  console.log(`✓ cleaned ${t}`)
}
