/**
 * Local HTTP preview server for generated walkthroughs.
 *
 * Pairs with `meander generate` to enable a dev cycle without
 * publishing to Val Town. Serves files out of the emit dir
 * next to the consumer's `meander.config.json` (default: `pages/`,
 * override via `meander.config.json`'s `outDir` field) and
 * rewrites path requests to match the URL shape the deployed
 * val uses:
 *
 * /                        → <outDir>/index.html
 * /:slug                   → <outDir>/index.html
 * /:slug/part/:n           → <outDir>/part-:n.html
 * /:slug/documents         → <outDir>/documents.html
 * /:slug/<asset>           → <outDir>/<asset>
 * /<asset>                 → <outDir>/<asset>
 *
 * No auth, no SSL, single-process. Ctrl+C to stop.
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import path from 'node:path'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

const logger = getDefaultLogger()

export type ServeOptions = {
  port?: number | undefined
  basePath?: string | undefined
}

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export { MIME }

/**
 * Read the slug + part ids + documents flag from manifest.json
 * so routeToFile can validate. Falls back to scanning the
 * directory if manifest isn't present (e.g. old builds).
 */
export async function readWalkthroughMeta(outDir: string): Promise<{
  slug: string
  partIds: Set<number>
  hasDocuments: boolean
}> {
  const manifestPath = path.join(outDir, 'manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const partIds = new Set<number>()
    for (const p of manifest.parts ?? []) {
      partIds.add(p.id)
    }
    return {
      slug: manifest.slug ?? '',
      partIds,
      hasDocuments: !!manifest.hasDocuments,
    }
  }
  // Fallback: scan part-N.html files
  const entries = await fs.readdir(outDir)
  const partIds = new Set<number>()
  for (const e of entries) {
    const m = e.match(/^part-(\d+)\.html$/)
    if (m) {
      partIds.add(Number(m[1]))
    }
  }
  return {
    slug: '',
    partIds,
    hasDocuments: entries.includes('documents.html'),
  }
}

/**
 * Translate a URL path to a file relative to the walkthrough
 * output dir. Mirrors the deployed val's routing rules so the
 * local preview matches what ships.
 */
export function routeToFile(
  slug: string,
  urlPath: string,
  partIds: ReadonlySet<number>,
  { hasDocuments }: { hasDocuments: boolean },
): string | undefined {
  if (urlPath === '' || urlPath === '/') {
    return 'index.html'
  }
  // Strip leading slash for downstream processing
  const clean = urlPath.replace(/^\/+/, '').replace(/\/+$/, '')
  // Slug-prefixed root
  if (clean === slug) {
    return 'index.html'
  }
  // /:slug/part/:n
  const partMatch = clean.match(
    new RegExp(`^${escapeRegex(slug)}/part/(\\d+)$`),
  )
  if (partMatch) {
    const n = Number(partMatch[1])
    if (partIds.has(n)) {
      return `part-${n}.html`
    }
    return undefined
  }
  // /:slug/documents
  if (hasDocuments && clean === `${slug}/documents`) {
    return 'documents.html'
  }
  // Strip slug prefix from asset-shaped requests so /<slug>/file.css
  // and /file.css both resolve to the same file on disk.
  const slugPrefix = `${slug}/`
  const asset = clean.startsWith(slugPrefix)
    ? clean.slice(slugPrefix.length)
    : clean
  return asset
}

export type ServeResult = {
  server: Server
  port: number
  url: string
}

export async function serve(
  configPath: string,
  options: ServeOptions = { __proto__: null } as ServeOptions,
): Promise<ServeResult | undefined> {
  /* Treat the directory that HOLDS meander.config.json as the
   * project root, not the caller's cwd. Matches `generate`'s
   * resolution so `pnpm dev` and `meander serve foo/bar.json`
   * both work from any cwd without cd-ing. */
  const rootDir = path.resolve(configPath, '..')
  /* Resolve the emit dir from meander.config.json's `outDir` field
   * (default "pages"). Reading just this one field — we don't
   * want to run the full schema validation here; serve should
   * work even when fields tangential to the emit dir are
   * invalid or in flux. Fallback handles missing/malformed
   * configs by using the default. */
  let outDirName = 'pages'
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      outDir?: string | undefined
    }
    if (
      typeof raw.outDir === 'string' &&
      /^[a-z0-9][a-z0-9-]*$/.test(raw.outDir)
    ) {
      outDirName = raw.outDir
    }
  } catch {
    /* fallback to default */
  }
  const outDir = path.join(rootDir, outDirName)
  if (!existsSync(outDir)) {
    logger.fail(
      `No emit dir found at ${outDir}.\n` +
        `Run \`meander generate ${configPath}\` first, or use \`pnpm run dev\`.`,
    )
    process.exitCode = 1
    return undefined
  }

  const { slug, partIds, hasDocuments } = await readWalkthroughMeta(outDir)
  const basePath = (options.basePath ?? '').replace(/\/$/, '')
  const port = options.port ?? 8080

  const server = createServer(async (req, res) => {
    const rawUrl = (req.url ?? '/').split('?')[0]!.split('#')[0]!
    let decoded: string
    try {
      decoded = decodeURIComponent(rawUrl)
    } catch {
      res.writeHead(400).end('bad request')
      return
    }
    // Strip base-path prefix if configured
    if (basePath && decoded.startsWith(basePath + '/')) {
      decoded = decoded.slice(basePath.length)
    } else if (basePath && decoded === basePath) {
      decoded = '/'
    }

    const relative = routeToFile(slug, decoded, partIds, { hasDocuments })
    if (relative === undefined) {
      res.writeHead(404).end('not found')
      return
    }

    const target = path.resolve(outDir, relative)
    /* v8 ignore start -- defense-in-depth traversal guard; routeToFile strips `..` before we get here. */
    if (target !== outDir && !target.startsWith(outDir + '/')) {
      res.writeHead(400).end('bad request')
      return
    }
    /* v8 ignore stop */

    if (!existsSync(target)) {
      res.writeHead(404).end('not found')
      return
    }

    try {
      // oxlint-disable-next-line socket/prefer-exists-sync -- need the metadata: stat() to reject directory targets via isDirectory(), not a bare existence check.
      const stats = await fs.stat(target)
      if (stats.isDirectory()) {
        res.writeHead(404).end('not found')
        return
      }
      const body = await fs.readFile(target)
      const ct =
        MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, {
        'content-type': ct,
        'content-length': body.length,
        'cache-control': 'no-cache',
      })
      res.end(body)
      /* v8 ignore start -- fs error after existsSync; concurrent-delete edge. */
    } catch {
      res.writeHead(500).end('internal server error')
    }
    /* v8 ignore stop */
  })

  return new Promise<ServeResult>(resolve => {
    server.listen(port, () => {
      const addr = server.address()
      /* v8 ignore next -- server.address() is always an object after successful listen(). */
      const boundPort =
        typeof addr === 'object' && addr && 'port' in addr ? addr.port : port
      const url = `http://127.0.0.1:${boundPort}${basePath}/`
      logger.log(`meander serving ${outDir} at ${url}`)
      /* v8 ignore next 3 -- slug is empty only when the manifest.json fallback-scan path runs without a slug. */
      if (slug) {
        logger.log(`  try: ${url}${slug}/part/${[...partIds][0] ?? 1}`)
      }
      logger.log('  Ctrl+C to stop')
      resolve({ server, port: boundPort, url })
    })
  })
}
