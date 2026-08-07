/**
 * Build-time minification passes.
 *
 * - `minifyEmittedHtml(html, options)` — walk every inline
 *
 *   <script> body through rolldown's minifier, every inline
 *   <svg> through SVGO. Returns the transformed HTML string.
 *
 * All passes are best-effort: a single malformed asset (rare
 * SVGO parser choke, invalid JS in a consumer-provided snippet)
 * is logged and the original content is kept. Callers get back
 * a string that's always valid HTML / CSS / JS even on partial
 * failure.
 *
 * `rolldown`, `svgo`, and `lightningcss` are loaded via dynamic
 * import so the generator still works when a consumer opts into
 * minify without installing rolldown. `svgo` and `lightningcss`
 * ship as direct meander deps; `rolldown` is a meander devDep
 * that consumers add to their own project if they want
 * inline-script / sw.js minification.
 */
import type { HTMLElement } from 'node-html-parser'
import { parse as parseHtml } from 'node-html-parser'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

const logger = getDefaultLogger()

/* Synthetic filename handed to rolldown's minifier so oxc parses the
 * source as plain JS (never TS/JSX) regardless of what the real emitted
 * asset is named.
 */
const JS_MINIFY_FILENAME = 'meander-inline.js'

export type MinifyHtmlOptions = {
  js?: boolean | undefined
  svg?: boolean | undefined
}

/**
 * SVGO config — preset-default with two overrides off:
 * - cleanupIds: mermaid uses IDs for edge-to-node linking;
 * collapsing them breaks arrows.
 * - removeUnknownsAndDefaults: mermaid emits attributes the
 * default list wants to strip (preserveAspectRatio variants)
 * that browsers read.
 */
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
 * Minify a standalone JS or CSS source string via rolldown's
 * minifier (JS) or lightningcss (CSS). Used for the external
 * meander.css and sw.js. Returns the original string on
 * failure so callers don't ship an empty/broken asset.
 */
export async function minifyAsset(
  code: string,
  kind: 'js' | 'css',
): Promise<string> {
  try {
    if (kind === 'css') {
      /* lightningcss throws SyntaxError on malformed CSS (csso
       * did not) — the outer try/catch below already treats any
       * throw from this branch as a minify failure and falls
       * back to the original source, so the malformed-CSS
       * contract is unchanged.
       */
      const { transform } = await import('lightningcss')
      const out = transform({
        code: Buffer.from(code),
        filename: 'meander.css',
        minify: true,
      })
      return out.code.toString() || code
    }
    const { minify } = await import('rolldown/experimental')
    const out = await minify(JS_MINIFY_FILENAME, code, {})
    if (out.errors.length > 0) {
      throw new Error(out.errors.map(e => e.message).join('; '))
    }
    return out.code
  } catch (e) {
    logger.fail(`[minify] ${kind} minify failed:`, (e as Error)?.message ?? e)
    return code
  }
}

export async function minifyEmittedHtml(
  html: string,
  options: MinifyHtmlOptions = { __proto__: null } as MinifyHtmlOptions,
): Promise<string> {
  const { js = true, svg = true } = {
    __proto__: null,
    ...options,
  } as MinifyHtmlOptions
  if (!js && !svg) {
    return html
  }

  const root = parseHtml(html)
  let changed = false

  if (js) {
    /* rolldown isn't installed — skip the JS pass rather than
     * erroring. Consumers enable minify.js by installing it
     * alongside mermaid + puppeteer.
     */
    const rolldownMod = await import('rolldown/experimental').catch(
      /* v8 ignore next -- optional-dep absence; rolldown is a meander devDep so this branch never fires in tests. */
      () => undefined,
    )
    if (rolldownMod) {
      const { minify } = rolldownMod
      const scripts = root.querySelectorAll('script')
      /* Inline <script> only — tags with a `src` attribute fetch
       * their body over the network and are minified (if at all)
       * at the file-emission step, not inside the HTML.
       */
      const inlineScripts: HTMLElement[] = []
      for (const s of scripts) {
        if (s.getAttribute('src')) {
          continue
        }
        if (!s.text) {
          continue
        }
        inlineScripts.push(s)
      }
      const results = await Promise.allSettled(
        inlineScripts.map(s => minify(JS_MINIFY_FILENAME, s.text, {})),
      )
      for (const [i, r] of results.entries()) {
        /* rolldown's minify() resolves even on a parse error — it
         * never rejects — so a failure shows up as a fulfilled
         * result carrying a non-empty `errors` array, not a
         * rejection. Both shapes are treated as failure here.
         */
        if (r.status !== 'fulfilled' || r.value.errors.length > 0) {
          const reason =
            r.status === 'fulfilled'
              ? r.value.errors.map(e => e.message).join('; ')
              : ((r.reason as Error)?.message ?? r.reason)
          logger.fail('[minify] inline <script> failed:', reason)
          continue
        }
        const el = inlineScripts[i]!
        /* Replace the text node inside the <script>. node-html-
         * parser exposes `set_content` for this exact case — a
         * direct textContent assignment would HTML-escape the JS.
         */
        el.set_content(r.value.code)
        changed = true
      }
    }
  }

  if (svg) {
    /* svgo isn't installed — skip the SVG pass rather than
     * erroring. Consumers who want it install it as a peer.
     */
    const svgoMod = await import('svgo').catch(
      /* v8 ignore next -- optional-dep absence; svgo is a direct dep here so this branch never fires in tests. */
      () => undefined,
    )
    if (svgoMod) {
      const svgs = root.querySelectorAll('svg')
      for (const el of svgs) {
        const before = el.toString()
        let after: string
        try {
          after = svgoMod.optimize(
            before,
            svgoConfig as Parameters<typeof svgoMod.optimize>[1],
          ).data
          /* v8 ignore start -- SVGO error path; third-party failure isn't our test surface. */
        } catch {
          continue
        }
        /* v8 ignore stop */
        if (after && after !== before) {
          el.replaceWith(after)
          changed = true
        }
      }
    }
  }

  return changed ? root.toString() : html
}
