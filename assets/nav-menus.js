/* Per-file navigation menus.
 *
 * Three subsystems:
 *   1. hydrateChip — per-code-chunk chips emit an empty
 *      <div class="mdr-sections-panel"></div> at build time to
 *      save repeated anchor markup. First open clones the
 *      file-head's full sections menu into the chip and marks
 *      the current chunk active.
 *   2. installMenuBehavior — outside-click / pick-a-link closes
 *      open menus; clicking a menu's summary closes any other
 *      open menu of the same family. Handles both
 *      .mdr-files-menu and .mdr-sections-menu uniformly.
 *   3. installFileTracking / installSectionTracking —
 *      IntersectionObserver picks the topmost-visible
 *      .file-block / .annotation-card and marks the matching
 *      row active in every open panel. */
'use strict'
;(() => {
  const ns = window[Symbol.for('meander:pages')]
  if (!ns) {
    return
  }

  const MENU = ':is(.mdr-files-menu, .mdr-sections-menu)'
  const PANEL_LINK = ':is(.mdr-files-panel, .mdr-sections-panel) a'

  const hydratedChips = new WeakSet()
  const hydrateChip = chip => {
    if (hydratedChips.has(chip)) {
      return
    }
    hydratedChips.add(chip)
    const blockId = chip.getAttribute('data-sections-for')
    const activeId = chip.getAttribute('data-active-id')
    if (!blockId) {
      return
    }
    const block = document.getElementById(blockId)
    const src = block?.querySelector(
      '.file-head .mdr-sections-menu .mdr-sections-panel',
    )
    const dest = chip.querySelector('.mdr-sections-panel')
    if (!src || !dest || dest.childElementCount > 0) {
      return
    }
    const clone = src.cloneNode(true)
    for (const a of clone.querySelectorAll('a.active')) {
      a.classList.remove('active')
    }
    if (activeId) {
      const match = clone.querySelector(`a[href="#${CSS.escape(activeId)}"]`)
      match?.classList.add('active')
    }
    dest.append(...clone.childNodes)
  }

  const installMenuBehavior = () => {
    for (const menu of document.querySelectorAll(MENU)) {
      menu.addEventListener('toggle', () => {
        if (!menu.open) {
          return
        }
        if (menu.classList.contains('mdr-section-chip')) {
          hydrateChip(menu)
        }
        /* Scroll the active row into the panel's visible area
         * so the current file/section isn't offscreen. */
        const panel = menu.querySelector(
          '.mdr-files-panel, .mdr-sections-panel',
        )
        const active = panel?.querySelector('a.active')
        if (!panel || !active) {
          return
        }
        const panelRect = panel.getBoundingClientRect()
        const activeRect = active.getBoundingClientRect()
        const centerOffset =
          activeRect.top -
          panelRect.top -
          panel.clientHeight / 2 +
          active.clientHeight / 2
        panel.scrollTop += centerOffset
      })
    }

    document.addEventListener('click', e => {
      const target = e.target
      const panelLink = target.closest?.(PANEL_LINK)
      const summary = target.closest?.(`${MENU} > summary`)
      const clickedMenu = summary?.parentElement
      const insideMenu = target.closest?.(MENU)
      const closeAll = panelLink || (!insideMenu && !summary)
      for (const menu of document.querySelectorAll(`${MENU}[open]`)) {
        if (closeAll || (summary && menu !== clickedMenu)) {
          menu.open = false
        }
      }
    })
  }

  const installFileTracking = () => {
    const blocks = [...document.querySelectorAll('.file-block[id]')]
    if (blocks.length === 0) {
      return
    }
    const panels = [...document.querySelectorAll('.mdr-files-panel')]
    if (panels.length === 0) {
      return
    }

    const setActive = id => {
      for (const panel of panels) {
        for (const link of panel.querySelectorAll('a.active')) {
          link.classList.remove('active')
        }
        if (!id) {
          continue
        }
        const match = panel.querySelector(`a[href="#${CSS.escape(id)}"]`)
        match?.classList.add('active')
      }
    }

    const visible = new Set()
    const pickTopmost = () => {
      let best = null
      let bestTop = Infinity
      for (const block of visible) {
        const top = block.getBoundingClientRect().top
        if (top >= 0 && top < bestTop) {
          best = block
          bestTop = top
        }
      }
      if (!best) {
        let bestNegTop = -Infinity
        for (const block of visible) {
          const top = block.getBoundingClientRect().top
          if (top < 0 && top > bestNegTop) {
            best = block
            bestNegTop = top
          }
        }
      }
      setActive(best?.id ?? null)
    }

    const io = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visible.add(entry.target)
          } else {
            visible.delete(entry.target)
          }
        }
        pickTopmost()
      },
      { rootMargin: '-20% 0px -70% 0px', threshold: 0 },
    )

    for (const block of blocks) {
      io.observe(block)
    }
  }

  const installSectionTracking = () => {
    const menusByAnchor = new Map()
    for (const panel of document.querySelectorAll('.mdr-sections-panel')) {
      for (const link of panel.querySelectorAll('a[href^="#"]')) {
        const id = link.getAttribute('href').slice(1)
        if (!id) {
          continue
        }
        let entry = menusByAnchor.get(id)
        if (!entry) {
          entry = { card: document.getElementById(id), panel, links: [] }
          menusByAnchor.set(id, entry)
        }
        entry.links.push(link)
      }
    }
    if (menusByAnchor.size === 0) {
      return
    }

    const currentByPanel = new WeakMap()
    const setActive = (panel, id) => {
      if (currentByPanel.get(panel) === id) {
        return
      }
      currentByPanel.set(panel, id)
      for (const link of panel.querySelectorAll('a.active')) {
        link.classList.remove('active')
      }
      if (id) {
        const entry = menusByAnchor.get(id)
        if (entry) {
          for (const link of entry.links) {
            if (link.parentElement === panel) {
              link.classList.add('active')
            }
          }
        }
      }
    }

    const visibleCards = new Set()
    const pickCurrentFor = panel => {
      let best = null
      let bestTop = Infinity
      for (const card of visibleCards) {
        if (!panel.closest('.file-block')?.contains(card)) {
          continue
        }
        const top = card.getBoundingClientRect().top
        if (top >= 0 && top < bestTop) {
          best = card
          bestTop = top
        }
      }
      if (!best) {
        let bestNegTop = -Infinity
        for (const card of visibleCards) {
          if (!panel.closest('.file-block')?.contains(card)) {
            continue
          }
          const top = card.getBoundingClientRect().top
          if (top < 0 && top > bestNegTop) {
            best = card
            bestNegTop = top
          }
        }
      }
      setActive(panel, best?.id ?? null)
    }

    const io = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleCards.add(entry.target)
          } else {
            visibleCards.delete(entry.target)
          }
        }
        /* Scroll-driven tracking applies only to the file-head's
         * sections menu — NOT the chip panels (they have their
         * active row baked in at hydration time from
         * data-active-id). */
        for (const panel of document.querySelectorAll('.mdr-sections-panel')) {
          if (panel.closest('.mdr-section-chip')) {
            continue
          }
          pickCurrentFor(panel)
        }
      },
      { rootMargin: '-20% 0px -70% 0px', threshold: 0 },
    )

    for (const { card } of menusByAnchor.values()) {
      if (card) {
        io.observe(card)
      }
    }
  }

  ns.onReady(() => {
    installMenuBehavior()
    installFileTracking()
    installSectionTracking()
  })
})()
