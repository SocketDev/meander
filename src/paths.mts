import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ASSETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'assets',
  'repo',
)
