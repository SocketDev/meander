/**
 * Diagnostic command: `meander doctor` reports system info +
 * resolves the optional peer deps that gate feature flags
 * (mermaid → puppeteer/mermaid/svgo; minify → esbuild/svgo).
 *
 * When a peer dep is missing, the feature it enables silently
 * no-ops at build time. `doctor` surfaces those gaps up front
 * so a consumer who set `{ "mermaid": true }` in
 * meander.config.json doesn't get a confusing runtime error when
 * the generator can't find puppeteer.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

const logger = getDefaultLogger()

export async function doctor(): Promise<void> {
  logger.log('meander doctor')
  logger.log(`  platform: ${process.platform}-${process.arch}`)
  logger.log(`  node:     ${process.version}`)
  logger.log(`  meander:  ${getMeanderVersion()}`)
  logger.log(`  cwd:      ${process.cwd()}`)
  logger.log('')
  logger.log('Optional peer dependencies')
  logger.log('  (only needed when the feature they gate is enabled)')
  logger.log('')

  const peers: Array<Omit<PeerStatus, 'resolved'>> = [
    {
      name: 'mermaid',
      required: '>=11',
      description: 'Render ```mermaid fenced blocks to SVG at build time',
    },
    {
      name: 'puppeteer',
      required: '>=23',
      description: 'Headless Chrome used by the mermaid renderer',
    },
    {
      name: 'svgo',
      required: '>=4',
      description: 'Shrink mermaid SVGs + inline <svg> in emitted HTML',
    },
    {
      name: 'esbuild',
      required: '>=0.25',
      description: 'Minify inline <script> + meander.css + sw.js',
    },
  ]

  const results: PeerStatus[] = await Promise.all(
    peers.map(async p => ({
      ...p,
      resolved: await resolvePeer(p.name),
    })),
  )

  const nameWidth = Math.max(...results.map(r => r.name.length))
  for (let i = 0, { length } = results; i < length; i += 1) {
    const r = results[i]!
    const pad = r.name.padEnd(nameWidth)
    const version = r.resolved
      ? r.resolved
      : `not installed (need ${r.required})`
    const detail = `${pad}  ${version}`
    if (r.resolved) {
      logger.success(detail)
    } else {
      logger.fail(detail)
    }
    logger.log(`    ${r.description}`)
  }

  const missing = results.filter(r => !r.resolved)
  logger.log('')
  if (missing.length === 0) {
    logger.log('All optional peers resolved.')
    return
  }
  logger.log(
    `${missing.length} optional peer(s) missing. Features requiring them ` +
      `silently no-op; install with:`,
  )
  logger.log('')
  logger.log(`  pnpm add -D ${missing.map(p => p.name).join(' ')}`)
}

/**
 * Self-resolve meander's own version so the report shows
 * which install this doctor is speaking for. Reads the
 * bundled package.json one level above the compiled output
 * (dist/doctor.js) or the source (src/doctor.mts).
 */
export function getMeanderVersion(): string {
  const thisFile = fileURLToPath(import.meta.url)
  const candidates = [
    path.join(path.dirname(thisFile), '..', 'package.json'),
    path.join(path.dirname(thisFile), '..', '..', 'package.json'),
  ]
  for (let i = 0, { length } = candidates; i < length; i += 1) {
    const c = candidates[i]!
    if (!existsSync(c)) {
      continue
    }
    try {
      const meta = JSON.parse(readFileSync(c, 'utf-8')) as {
        name?: string | undefined
        version?: string | undefined
      }
      /* Only trust the result when the name matches — a parent
       * package.json in a monorepo checkout would still parse. */
      if (meta.name === '@socketsecurity/meander' && meta.version) {
        return meta.version
      }
    } catch {
      /* malformed JSON — try the next candidate */
    }
  }
  return 'unknown'
}

export type PeerStatus = {
  name: string
  required: string
  resolved: string | undefined
  description: string
}

/**
 * Resolve a peer dep via `require.resolve` from the caller's
 * cwd. Returns the resolved version or `null` if not found.
 *
 * Two-step: first confirm the package is resolvable via its
 * main entry (some packages — svgo, puppeteer — have strict
 * `exports` maps that reject `./package.json`), then walk up
 * from the main entry to find package.json on disk and read
 * its version.
 */
export async function resolvePeer(name: string): Promise<string | undefined> {
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(path.join(process.cwd(), 'package.json'))
    let entryPath: string
    try {
      entryPath = req.resolve(name)
    } catch {
      return undefined
    }
    /* Walk up directories from the resolved entry until we hit
     * a package.json whose `name` matches. Handles nested
     * node_modules + workspace links without depending on the
     * package's own `exports`. */
    let dir = path.dirname(entryPath)
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'package.json')
      if (existsSync(candidate)) {
        try {
          const meta = JSON.parse(readFileSync(candidate, 'utf-8')) as {
            name?: string | undefined
            version?: string | undefined
          }
          if (meta.name === name) {
            return meta.version ?? 'unknown'
          }
        } catch {
          /* malformed package.json — keep walking */
        }
      }
      dir = path.dirname(dir)
    }
    return 'unknown'
  } catch {
    return undefined
  }
}
