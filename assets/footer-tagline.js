/* Footer tagline rotator — picks a random entry from the
 * .mdr-footer-tagline element's data-taglines JSON array on
 * every page load and swaps the link's text content. The
 * server-rendered text (data-taglines[0]) acts as the no-JS
 * fallback; this script just adds variety. */
;(function () {
  'use strict'

  const ns = window[Symbol.for('meander:pages')]
  if (!ns) {
    return
  }

  ns.onReady(() => {
    const link = document.querySelector('.mdr-footer-tagline')
    if (!link) {
      return
    }
    const raw = link.getAttribute('data-taglines')
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
    if (typeof pick === 'string' && pick.length > 0 && pick !== link.textContent) {
      link.textContent = pick
    }
  })
})()
