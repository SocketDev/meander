/* Walkthrough boot — shared namespace + runtime primitives.
 *
 * Namespace: window[Symbol.for('meander:pages')]. Boot is the
 * first script in the inlined bundle, so later modules always
 * see `ns` populated.
 *
 * Primitives:
 *   - ns.storageGet(key)        guarded localStorage read
 *   - ns.storageSet(key, value) guarded write (null ⇒ remove)
 *   - ns.onReady(fn)            run after DOMContentLoaded */
'use strict'
;(() => {
  const ns = (window[Symbol.for('meander:pages')] ??= {})

  /* Desktop + iOS Safari emit "…Safari/…" in their UA string
   * without any Chromium-family marker. Flagging them via
   * html[data-ua="safari"] lets CSS gate features that have
   * known Safari quirks — e.g. content-visibility: auto still
   * has :target + find-in-page glitches in Safari 18+. No-op
   * on every other browser. */
  const ua = navigator.userAgent
  if (
    ua.includes('Safari/') &&
    !ua.includes('Chrome/') &&
    !ua.includes('Chromium/') &&
    !ua.includes('Edg/')
  ) {
    document.documentElement.setAttribute('data-ua', 'safari')
  }

  ns.storageGet = key => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }

  ns.storageSet = (key, value) => {
    try {
      if (value === null) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, value)
      }
    } catch {
      /* private mode / quota / disabled — ignore */
    }
  }

  const safe = (tag, fn) => {
    try {
      fn()
    } catch (e) {
      console.error(`[meander:pages] ${tag}:`, e)
    }
  }

  ns.onReady = fn => {
    const run = () => safe('onReady', fn)
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true })
    } else {
      run()
    }
  }

  /* Popover registry — keeps the topbar's various menus mutually
   * exclusive. Each module registers a closer on install; before
   * opening its own popover it calls openExclusive(self) which
   * fires every other registered closer. Errors in one closer
   * don't prevent the others from running.
   *
   *   const closer = () => closeMenu();
   *   ns.popovers.register(closer);
   *   ...
   *   btn.addEventListener("click", () => {
   *     ns.popovers.openExclusive(closer);
   *     openMenu();
   *   });
   */
  const closers = new Set()
  ns.popovers = {
    register(close) {
      closers.add(close)
      return () => closers.delete(close)
    },
    openExclusive(self) {
      for (const close of closers) {
        if (close !== self) {
          safe('popovers.close', close)
        }
      }
    },
    closeAll() {
      for (const close of closers) {
        safe('popovers.close', close)
      }
    },
  }

  /* WAI-ARIA Authoring Practices "menu button" keyboard pattern.
   * Wires Esc / ArrowUp / ArrowDown / Home / End / Tab on the
   * trigger button + panel pair, plus aria-expanded sync on every
   * open/close. The caller still owns the open/close mechanics —
   * this just layers keyboard behavior on top.
   *
   *   ns.popovers.bindKeyboard({
   *     trigger:  buttonEl,
   *     panel:    panelEl,
   *     itemSelector: '.menu-item, [role="menuitem"]',
   *     isOpen:   () => boolean,
   *     open:     () => void,
   *     close:    () => void,
   *   })
   *
   * The `itemSelector` query runs at every keystroke so dropdowns
   * with async-loaded items (e.g. unresolved-comments fetch) keep
   * working as the list materialises. */
  ns.popovers.bindKeyboard = ({
    trigger,
    panel,
    itemSelector,
    isOpen,
    open,
    close,
  }) => {
    if (!trigger || !panel) {
      return
    }
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'false')

    const items = () => Array.from(panel.querySelectorAll(itemSelector))
    const focusFirst = () => {
      const list = items()
      if (list.length > 0) {
        list[0].focus()
      }
    }
    const focusLast = () => {
      const list = items()
      if (list.length > 0) {
        list[list.length - 1].focus()
      }
    }
    const focusRelative = step => {
      const list = items()
      if (list.length === 0) {
        return
      }
      const idx = list.indexOf(document.activeElement)
      const next = (idx + step + list.length) % list.length
      list[next].focus()
    }

    /* Trigger keys — ArrowDown opens + focuses first item; ArrowUp
     * opens + focuses last (matches macOS menu convention). */
    trigger.addEventListener('keydown', e => {
      switch (e.key) {
        case 'ArrowDown':
        case 'Down':
          e.preventDefault()
          if (!isOpen()) {
            open()
          }
          focusFirst()
          break
        case 'ArrowUp':
        case 'Up':
          e.preventDefault()
          if (!isOpen()) {
            open()
          }
          focusLast()
          break
        case 'Escape':
        case 'Esc':
          if (isOpen()) {
            e.preventDefault()
            close()
          }
          break
        default:
          break
      }
    })

    /* Panel keys — only fire when the panel has focus (i.e. an
     * item inside it is the active element). */
    panel.addEventListener('keydown', e => {
      if (!isOpen()) {
        return
      }
      switch (e.key) {
        case 'ArrowDown':
        case 'Down':
          e.preventDefault()
          focusRelative(1)
          break
        case 'ArrowUp':
        case 'Up':
          e.preventDefault()
          focusRelative(-1)
          break
        case 'Home':
          e.preventDefault()
          focusFirst()
          break
        case 'End':
          e.preventDefault()
          focusLast()
          break
        case 'Escape':
        case 'Esc':
          e.preventDefault()
          close()
          trigger.focus()
          break
        case 'Tab':
          /* APG menu pattern: Tab closes the menu and lets focus
           * fall through to the next focusable element after the
           * trigger. Don't preventDefault — the browser's natural
           * tab order takes over. */
          close()
          break
        default:
          break
      }
    })
  }

  /* Helper for callers to keep the trigger's aria-expanded in
   * sync without re-implementing the toggle dance. */
  ns.popovers.setExpanded = (trigger, value) => {
    if (trigger) {
      trigger.setAttribute('aria-expanded', value ? 'true' : 'false')
    }
  }

  /* Run `fn` once hljs has tokenized the first `.line-code code`
   * block. hljs splits text nodes when it runs, so any module
   * that walks the tokenized tree (hotlinks, inline-tokenizer)
   * has to wait or its <a>/<span> wraps get blown away. 1.5s cap
   * + once-guard so a slow CDN can't stall work, and the observer
   * + timeout can't both fire. Resolves immediately if there are
   * no code blocks or hljs already ran. */
  ns.onHljsReady = fn => {
    ns.onReady(() => {
      const codes = document.querySelectorAll('.line-code code')
      let fired = false
      const once = () => {
        if (fired) {
          return
        }
        fired = true
        safe('onHljsReady', fn)
      }
      if (codes.length === 0 || codes[0].classList.contains('hljs')) {
        once()
        return
      }
      const obs = new MutationObserver(() => {
        if (codes[0].classList.contains('hljs')) {
          obs.disconnect()
          once()
        }
      })
      obs.observe(codes[0], { attributes: true, attributeFilter: ['class'] })
      setTimeout(() => {
        obs.disconnect()
        once()
      }, 1500)
    })
  }
})()
