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
 *   /                        → <outDir>/index.html
 *   /:slug                   → <outDir>/index.html
 *   /:slug/part/:n           → <outDir>/part-:n.html
 *   /:slug/documents         → <outDir>/documents.html
 *   /:slug/<asset>           → <outDir>/<asset>
 *   /<asset>                 → <outDir>/<asset>
 *
 * No auth, no SSL, single-process. Ctrl+C to stop.
 */
import { readFileSync, existsSync, promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

type ServeOptions = {
  port?: number | undefined
  basePath?: string | undefined
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
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
  hasDocuments: boolean,
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
  /* Accept both the new `part-<n>.html` filename and the legacy
   * `walkthrough-part-<n>.html` so a consumer regenerating over
   * an older output dir (or serving a mid-migration deploy)
   * still picks up the parts list. The new name is preferred;
   * regex is anchored to one-or-the-other. */
  for (const e of entries) {
    const m = e.match(/^(?:walkthrough-)?part-(\d+)\.html$/)
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

export type ServeResult = {
  server: import('node:http').Server
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
      outDir?: string
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
  /* Backward-compat: if the configured outDir doesn't exist but
   * the legacy "walkthrough" dir does, serve from there. Lets a
   * mid-migration consumer keep serving while they regenerate
   * under the new name. */
  let outDir = path.join(rootDir, outDirName)
  if (!existsSync(outDir)) {
    const legacyDir = path.join(rootDir, 'walkthrough')
    if (existsSync(legacyDir)) {
      outDir = legacyDir
    }
  }
  if (!existsSync(outDir)) {
    console.error(
      `No emit dir found at ${outDir}.\n` +
        `Run \`meander generate ${configPath}\` first, or use \`pnpm run dev\`.`,
    )
    process.exitCode = 1
    return
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

    const relative = routeToFile(slug, decoded, partIds, hasDocuments)
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
      console.log(`meander serving ${outDir} at ${url}`)
      /* v8 ignore next 3 -- slug-aware hint log; slug is empty only for legacy fallback without manifest. */
      if (slug) {
        console.log(`  try: ${url}${slug}/part/${[...partIds][0] ?? 1}`)
      }
      console.log('  Ctrl+C to stop')
      resolve({ server, port: boundPort, url })
    })
  })
}
