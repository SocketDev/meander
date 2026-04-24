/**
 * Build-time minification passes.
 *
 *   - `minifyEmittedHtml(html, options)` — walk every inline
 *     <script> body through esbuild, every inline <svg> through
 *     SVGO. Returns the transformed HTML string.
 *   - `minifyAsset(bytes, kind)` — minify a standalone JS or
 *     CSS file's contents. Used for walkthrough.css + sw.js.
 *
 * All passes are best-effort: a single malformed asset (rare
 * SVGO parser choke, invalid JS in a consumer-provided snippet)
 * is logged and the original content is kept. Callers get back
 * a string that's always valid HTML / CSS / JS even on partial
 * failure.
 *
 * `esbuild` is already a meander devDep. `svgo` is a peer dep
 * (optional) — consumers who want inline-SVG shrinking install
 * it alongside their mermaid + puppeteer peers.
 */
import { HTMLElement, parse as parseHtml } from "node-html-parser";

export type MinifyHtmlOptions = {
  js?: boolean | undefined;
  svg?: boolean | undefined;
};

/**
 * SVGO config — preset-default with two overrides off:
 *   - cleanupIds: mermaid uses IDs for edge-to-node linking;
 *     collapsing them breaks arrows.
 *   - removeUnknownsAndDefaults: mermaid emits attributes the
 *     default list wants to strip (preserveAspectRatio variants)
 *     that browsers read.
 */
const svgoConfig = {
  multipass: true,
  plugins: [
    {
      name: "preset-default",
      params: {
        overrides: {
          cleanupIds: false,
          removeUnknownsAndDefaults: false,
        },
      },
    },
  ],
};

export async function minifyEmittedHtml(
  html: string,
  options: MinifyHtmlOptions = { __proto__: null } as MinifyHtmlOptions,
): Promise<string> {
  const { js = true, svg = true } = {
    __proto__: null,
    ...options,
  } as MinifyHtmlOptions;
  if (!js && !svg) {
    return html;
  }

  const root = parseHtml(html);
  let changed = false;

  if (js) {
    const { transform } = await import("esbuild");
    const scripts = root.querySelectorAll("script");
    /* Inline <script> only — tags with a `src` attribute fetch
     * their body over the network and are minified (if at all)
     * at the file-emission step, not inside the HTML. */
    const inlineScripts: HTMLElement[] = [];
    for (const s of scripts) {
      if (s.getAttribute("src")) {
        continue;
      }
      if (!s.text) {
        continue;
      }
      inlineScripts.push(s);
    }
    const results = await Promise.allSettled(
      inlineScripts.map((s) =>
        transform(s.text, {
          loader: "js",
          minify: true,
          target: "es2022",
          legalComments: "none",
        }),
      ),
    );
    for (const [i, r] of results.entries()) {
      if (r.status !== "fulfilled") {
        console.error(
          "[minify] inline <script> failed:",
          (r.reason as Error)?.message ?? r.reason,
        );
        continue;
      }
      const el = inlineScripts[i]!;
      /* Replace the text node inside the <script>. node-html-
       * parser exposes `set_content` for this exact case — a
       * direct textContent assignment would HTML-escape the JS. */
      el.set_content(r.value.code);
      changed = true;
    }
  }

  if (svg) {
    let svgoMod: typeof import("svgo") | null = null;
    try {
      svgoMod = await import("svgo");
    } catch {
      /* svgo isn't installed — skip the SVG pass rather than
       * erroring. Consumers who want it install it as a peer. */
    }
    if (svgoMod) {
      const svgs = root.querySelectorAll("svg");
      for (const el of svgs) {
        const before = el.toString();
        let after: string;
        try {
          after = svgoMod.optimize(
            before,
            svgoConfig as Parameters<typeof svgoMod.optimize>[1],
          ).data;
        } catch {
          continue;
        }
        if (after && after !== before) {
          el.replaceWith(after);
          changed = true;
        }
      }
    }
  }

  return changed ? root.toString() : html;
}

export type MinifyAssetOptions = {
  kind: "js" | "css";
};

/**
 * Minify a standalone JS or CSS source string via esbuild.
 * Used for the external walkthrough.css and sw.js. Returns
 * the original string on failure so callers don't ship an
 * empty/broken asset.
 */
export async function minifyAsset(
  code: string,
  options: MinifyAssetOptions,
): Promise<string> {
  const { kind } = { __proto__: null, ...options } as MinifyAssetOptions;
  try {
    const { transform } = await import("esbuild");
    const out = await transform(code, {
      loader: kind,
      minify: true,
      target: "es2022",
      legalComments: "none",
    });
    return out.code;
  } catch (e) {
    console.error(
      `[minify] ${kind} minify failed:`,
      (e as Error)?.message ?? e,
    );
    return code;
  }
}
