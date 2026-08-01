import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
const logger = getDefaultLogger()

/* Inline-code tokenizer registry.
 *
 * Consumers can register custom classifier + tokenizer pairs
 * that run against every inline <code> span in prose (annotation
 * bodies + rendered markdown). The first tokenizer whose
 * classifier returns truthy wins; its tokenize(text) returns
 * HTML that replaces the code's textContent. Unmatched spans
 * get hljs TypeScript tokenization as the final fallback.
 *
 * Register by pushing into:
 *   window[Symbol.for("meander:inline-tokenizers")]
 *
 * Each entry:
 *   {
 *     name: "purl",                         // debug label
 *     classify: (text) => boolean,          // "is this mine?"
 *     tokenize: (text) => htmlString,       // render HTML
 *   }
 *
 * Registration runs any time before this module's deferred
 * pass — push into the array whenever the page loads, and
 * this module processes every element in order. The registry
 * itself is idempotent: already-tokenized <code> carries
 * `data-mdr-tokenized` and is skipped on subsequent passes.
 *
 * Scope: every inline <code> inside .annotation-md or
 * .doc-content that isn't already inside a <pre>. Block code
 * (fenced code) is left alone — hljs already highlights those
 * at the block level. */
;(() => {
  const ns = window[Symbol.for('meander:pages')]
  if (!ns) {
    return
  }

  const registryKey = Symbol.for('meander:inline-tokenizers')
  /* Initialize the registry if this is the first module to
   * touch it. Consumers can register before OR after this file
   * loads — the symbol-keyed array is a stable handle either
   * way. */
  const registry = (window[registryKey] ??= [])

  const tokenize = code => {
    if (code.getAttribute('data-mdr-tokenized')) {
      return
    }
    const text = code.textContent ?? ''
    if (!text) {
      return
    }
    for (const entry of registry) {
      try {
        if (entry.classify?.(text)) {
          const html = entry.tokenize?.(text)
          if (typeof html === 'string') {
            code.innerHTML = html
            code.setAttribute('data-mdr-tokenized', entry.name ?? 'custom')
            return
          }
        }
      } catch (e) {
        /* A single bad tokenizer shouldn't kill the page —
         * log and move on to the next candidate. */
        logger.fail(`[meander:inline-tokenizers] ${entry.name}:`, e)
      }
    }
    /* Fallback: hljs TypeScript. Gated on hljs being present
     * (may not be on doc-only pages). */
    if (window.hljs && typeof window.hljs.highlight === 'function') {
      try {
        const result = window.hljs.highlight(text, {
          language: 'typescript',
          ignoreIllegals: true,
        })
        code.innerHTML = result.value
        code.setAttribute('data-mdr-tokenized', 'hljs')
      } catch {
        /* hljs can throw on unknown languages or malformed
         * input — leave the plain text in place. */
      }
    }
  }

  const pass = () => {
    const selector =
      ':is(.annotation-md, .doc-content, .mdr-hero-desc) code:not(pre code):not([data-mdr-tokenized])'
    for (const code of document.querySelectorAll(selector)) {
      tokenize(code)
    }
  }

  /* Run after hljs finishes its block-level pass so tokenizers
   * that delegate to hljs.highlight() work. onHljsReady is a
   * no-op when there's no hljs content on the page, so
   * doc-only surfaces still get tokenized. */
  ns.onHljsReady(pass)
})()
