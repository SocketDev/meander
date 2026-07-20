/**
 * Build-time Mermaid → SVG renderer.
 *
 * Why build-time, not client-side:
 *
 * - Zero client JS. Pages ship finished SVG; no mermaid bundle, no render flash,
 *   no layout shift.
 * - Keeps CSP tight; no extra script-src entry.
 * - SVGO pass shrinks each diagram ~30%.
 *
 * How it works:
 *
 * 1. Spin up one shared puppeteer browser per build.
 * 2. Hash source + theme + mermaid version. Cache hit → return SVG from disk.
 * 3. Otherwise render into a DOM-attached container (the mermaid-isomorphic
 *    pattern — getBBox() on a detached node returns zero or stale metrics) and
 *    grab the SVG.
 * 4. Pipe through SVGO. Write to cache + return.
 *
 * Puppeteer + mermaid + svgo are optional peer deps so the
 * dependency footprint is only paid by consumers who use them.
 * Without them installed, createMermaidRenderer throws and
 * markdown processing falls back to leaving ```mermaid blocks
 * as inert <pre><code> — consumers see the raw source.
 */
import crypto from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import type * as puppeteer from 'puppeteer'
import type * as svgo from 'svgo'

const logger = getDefaultLogger()

export type MermaidTheme = 'default' | 'dark' | 'neutral' | 'forest'

export type MermaidRenderer = {
  render: (source: string, theme: MermaidTheme) => Promise<string>
  close: () => Promise<void>
}

export type MermaidRendererConfig = {
  repoRoot: string
  cacheDir: string
}

/* SVGO config — preset-default with two overrides disabled:
 *   - cleanupIds: mermaid uses IDs for edge-to-node linking;
 *     collapsing them breaks arrows.
 *   - removeUnknownsAndDefaults: mermaid emits preserveAspectRatio
 *     variants that the default list wants to strip, but browsers
 *     use them. */
const svgoConfig = {
  multipass: true,
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          cleanupIds: false,
          removeUnknownsAndDefaults: false,
        },
      },
    },
  ],
}

/**
 * Create a renderer backed by a shared puppeteer browser. Call
 * `close()` when the build is done.
 *
 * Throws if `puppeteer` or `svgo` isn't installed. Mermaid is
 * loaded from disk (the source text is injected into the page),
 * so it also has to be in the consumer's node_modules.
 */
export async function createMermaidRenderer(
  config: MermaidRendererConfig,
): Promise<MermaidRenderer> {
  const { repoRoot, cacheDir } = config

  const mermaidJsPath = path.join(
    repoRoot,
    'node_modules',
    'mermaid',
    'dist',
    'mermaid.min.js',
  )
  if (!existsSync(mermaidJsPath)) {
    throw new Error(
      `mermaid not installed at ${mermaidJsPath}. Install with: pnpm add -D mermaid puppeteer svgo`,
    )
  }
  const mermaidJs = await fs.readFile(mermaidJsPath, 'utf8')
  const mermaidPkgPath = path.join(
    repoRoot,
    'node_modules',
    'mermaid',
    'package.json',
  )
  const mermaidVersion = existsSync(mermaidPkgPath)
    ? ((
        JSON.parse(await fs.readFile(mermaidPkgPath, 'utf8')) as {
          version?: string | undefined
        }
      ).version ?? '0')
    : '0'

  /* Dynamic imports so consumers without mermaid/puppeteer/svgo
   * don't fail to load meander itself — only fail when they
   * actually try to render a diagram. */
  let puppeteerMod: { launch: typeof puppeteer.launch }
  try {
    puppeteerMod = (await import('puppeteer')) as unknown as {
      launch: typeof puppeteer.launch
    }
  } catch {
    throw new Error(
      'puppeteer not installed. Install with: pnpm add -D puppeteer',
    )
  }
  let svgoMod: typeof svgo
  try {
    svgoMod = await import('svgo')
  } catch {
    throw new Error('svgo not installed. Install with: pnpm add -D svgo')
  }

  await fs.mkdir(cacheDir, { recursive: true })

  /* Lazy-launch — pay the Chromium boot cost (~1-2s) only when
   * there's a cache miss. Unchanged diagrams are pure disk reads. */
  let browser: puppeteer.Browser | undefined = undefined
  const ensureBrowser = async (): Promise<puppeteer.Browser> => {
    if (!browser) {
      browser = await puppeteerMod.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      })
    }
    return browser
  }

  const render = async (
    source: string,
    theme: MermaidTheme,
  ): Promise<string> => {
    const key = crypto.hash(
      'sha256',
      `${mermaidVersion}\n${theme}\n${source}`,
      'hex',
    )
    const cachePath = path.join(cacheDir, `${key}.svg`)
    if (existsSync(cachePath)) {
      return fs.readFile(cachePath, 'utf8')
    }

    const activeBrowser = await ensureBrowser()
    const page = await activeBrowser.newPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>
          body { margin: 0; padding: 20px; font-family: Helvetica, Arial, sans-serif; }
          #out { width: 1200px; }
        </style><script>${mermaidJs}</script></head><body><div id="out"></div></body></html>`,
      )
      await page.setViewport({ width: 1400, height: 900 })
      await page.evaluate(
        async (src: string, themeArg: string) => {
          const mermaid = (window as unknown as { mermaid: unknown })
            .mermaid as {
            initialize: (opts: Record<string, unknown>) => void
            render: (
              id: string,
              src: string,
              container: Element,
            ) => Promise<{ svg: string }>
          }
          /* Wait for fonts so mermaid measures labels against the
           * font that will actually paint. Without this, mermaid
           * uses fallback metrics and labels overflow their nodes. */
          await document.fonts.ready
          await Promise.allSettled(
            [...document.fonts].map((f: FontFace) => f.load()),
          )
          /* Real DOM-attached container — getBBox() returns stale
           * or zero metrics on detached nodes. Hidden via max-height
           * + opacity rather than unmounted. */
          const container = document.createElement('div')
          Object.assign(container.style, {
            maxHeight: '0',
            opacity: '0',
            overflow: 'hidden',
          })
          container.setAttribute('aria-hidden', 'true')
          document.body.append(container)
          mermaid.initialize({
            startOnLoad: false,
            theme: themeArg,
            securityLevel: 'strict',
            /* MUST be top-level in mermaid 11.12.3+. Nested
             * flowchart.htmlLabels is deprecated; forces <foreignObject>
             * labels that hit a max-width:200px clipping bug
             * (mermaid #5785). Top-level htmlLabels:false forces
             * pure SVG <text>. */
            htmlLabels: false,
            flowchart: {
              curve: 'basis',
              useMaxWidth: false,
              nodeSpacing: 80,
              rankSpacing: 80,
              padding: 30,
            },
            fontFamily: 'Helvetica, Arial, sans-serif',
            fontSize: 14,
            themeVariables: {
              fontFamily: 'Helvetica, Arial, sans-serif',
              fontSize: '14px',
            },
          })
          const { svg } = await mermaid.render('diagram', src, container)
          const out = document.getElementById('out')
          if (out) {
            out.innerHTML = svg
          }
        },
        source,
        theme,
      )
      const rawSvg = (await page.$eval(
        '#out svg',
        el => el.outerHTML,
      )) as string
      /* SVGO pass — mermaid occasionally emits constructs SVGO's
       * parser dislikes; raw SVG on failure is visually correct. */
      let finalSvg: string
      try {
        const optimized = svgoMod.optimize(
          rawSvg,
          svgoConfig as Parameters<typeof svgoMod.optimize>[1],
        )
        finalSvg = optimized.data
      } catch {
        finalSvg = rawSvg
      }
      await fs.writeFile(cachePath, finalSvg)
      return finalSvg
    } finally {
      await page.close()
    }
  }

  const close = async (): Promise<void> => {
    if (browser) {
      await browser.close()
      browser = undefined
    }
  }

  return { render, close }
}

/**
 * Replace the placeholder tokens left by `preRenderMermaidBlocks`
 * with their rendered SVGs. Run after marked.parse().
 */
export function inlineMermaidSvgs(
  html: string,
  svgByToken: Map<string, string>,
): string {
  let out = html
  for (const [token, svg] of svgByToken) {
    out = out.replace(token, svg)
  }
  return out
}

/**
 * Process ```mermaid fenced blocks in a markdown string: replace
 * each one with a placeholder token whose SVG is filled in after
 * rendering. Returns the transformed markdown + a map of token
 * IDs to SVG strings so a post-pass can swap them back in after
 * marked.parse() runs.
 *
 * Two-pass because marked's custom code-renderer is sync; SVG
 * rendering is async.
 */
export type PreRenderOptions = {
  theme?: MermaidTheme | undefined
}

export async function preRenderMermaidBlocks(
  markdown: string,
  renderer: MermaidRenderer,
  options: PreRenderOptions = { __proto__: null } as PreRenderOptions,
): Promise<{ markdown: string; svgByToken: Map<string, string> }> {
  const { theme = 'default' } = {
    __proto__: null,
    ...options,
  } as PreRenderOptions
  const svgByToken = new Map<string, string>()
  const fencePattern = /```mermaid\n([\s\S]*?)```/g
  let counter = 0
  const pending: Array<Promise<void>> = []
  const tokens: Array<{ match: string; token: string }> = []
  let m
  while ((m = fencePattern.exec(markdown)) !== null) {
    const source = m[1]!
    const token = `MDR_MERMAID_TOKEN_${counter++}`
    tokens.push({ match: m[0], token })
    pending.push(
      renderer.render(source, theme).then(svg => {
        svgByToken.set(token, svg)
      }),
    )
  }
  /* allSettled: a single failed diagram shouldn't abort the
   * whole batch. The renderer logs per-diagram failures; we
   * still emit placeholders for the diagrams that failed (the
   * token stays in the HTML and the SVG map just won't have
   * an entry for it — `inlineMermaidSvgs` leaves such tokens
   * as-is). */
  const results = await Promise.allSettled(pending)
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const token = tokens[i]?.token ?? '?'
      logger.fail(
        `[mermaid] ${token} render failed:`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      )
    }
  }
  let out = markdown
  for (const { match, token } of tokens) {
    out = out.replace(match, `<div class="mdr-mermaid">${token}</div>`)
  }
  return { markdown: out, svgByToken }
}
