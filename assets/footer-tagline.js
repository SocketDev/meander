/* Footer tagline rotator — picks a random prefix on every page
 * load and updates the .mdr-footer-tagline span. The brand word
 * "meander" lives in a sibling <a> element and is never touched.
 *
 * Two attribute shapes supported for backward-compat:
 *   - data-tagline-prefixes: array of prefixes, "<prefix> meander"
 *     is reconstructed visually via the sibling link
 *   - data-taglines: array of full strings (legacy fallback when
 *     the consumer's pool doesn't end "...with meander") — in
 *     that case the whole element is the link and we swap its
 *     entire text content
 */
;(function () {
  'use strict'

  const ns = window[Symbol.for('meander:pages')]
  if (!ns) {
    return
  }

  ns.onReady(() => {
    const el = document.querySelector('.mdr-footer-tagline')
    if (!el) {
      return
    }
    const prefixesRaw = el.getAttribute('data-tagline-prefixes')
    const taglinesRaw = el.getAttribute('data-taglines')
    const raw = prefixesRaw || taglinesRaw
    if (!raw) {
      return
    }
    let pool
    try {
      pool = JSON.parse(raw)
    } catch (_) {
      return
    }
    if (!Array.isArray(pool) || pool.length < 2) {
      return
    }
    const pick = pool[Math.floor(Math.random() * pool.length)]
    if (typeof pick === 'string' && pick.length > 0 && pick !== el.textContent) {
      el.textContent = pick
    }
  })
})()
