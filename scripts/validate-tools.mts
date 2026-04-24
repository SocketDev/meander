/**
 * Validate external-tools.json against its TypeBox schema.
 *
 * Invoked from `pnpm run check` via scripts/check.mts so a
 * malformed tools file (typo in a platform key, missing
 * checksum, etc.) fails the same check run that catches lint
 * + type errors. Same pattern as meander.config.json validation.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const ChecksumSchema = Type.Object({
  asset: Type.String({ minLength: 1 }),
  sha256: Type.String({
    minLength: 64,
    maxLength: 64,
    pattern: '^[0-9a-f]{64}$',
  }),
})

/* Per-platform checksums — every key is optional (zizmor skips
 * win-arm64, sfw skips win-arm64, etc.). TypeBox's Record with
 * a union-of-literal keys treats every literal as required,
 * which doesn't match our "subset is fine" semantics — use an
 * explicit Object with each platform as Optional instead. */
const ChecksumMapSchema = Type.Object({
  'linux-x64': Type.Optional(ChecksumSchema),
  'linux-arm64': Type.Optional(ChecksumSchema),
  'darwin-x64': Type.Optional(ChecksumSchema),
  'darwin-arm64': Type.Optional(ChecksumSchema),
  'win-x64': Type.Optional(ChecksumSchema),
  'win-arm64': Type.Optional(ChecksumSchema),
})

const ToolEntrySchema = Type.Object({
  description: Type.String({ minLength: 1 }),
  repository: Type.String({ pattern: '^github:[^/]+/[^/]+$' }),
  version: Type.String({ minLength: 1 }),
  release: Type.Union([Type.Literal('asset'), Type.Literal('binary')]),
  checksums: ChecksumMapSchema,
})

const ExternalToolsSchema = Type.Record(
  Type.String({ minLength: 1 }),
  ToolEntrySchema,
)

export type ExternalTools = Static<typeof ExternalToolsSchema>

export function validateExternalTools(filePath: string): ExternalTools {
  const resolved = path.resolve(filePath)
  const raw: unknown = JSON.parse(readFileSync(resolved, 'utf-8'))
  if (!Value.Check(ExternalToolsSchema, raw)) {
    const errors = [...Value.Errors(ExternalToolsSchema, raw)]
    const messages = errors
      .map(e => `  ${e.path || '(root)'}: ${e.message}`)
      .join('\n')
    throw new Error(`Invalid external-tools.json at ${resolved}:\n${messages}`)
  }
  return raw
}

/* Allow running as a standalone script: `node --experimental-
 * strip-types validate-tools.mts`. Prints a ✓ on success,
 * exits non-zero on validation failure. */
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(scriptDir, '..')
  const toolsPath = path.join(repoRoot, 'external-tools.json')
  try {
    const tools = validateExternalTools(toolsPath)
    const count = Object.keys(tools).length
    console.log(`✓ external-tools.json valid (${count} tools)`)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exitCode = 1
  }
}
