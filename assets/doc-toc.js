;(function () {
  'use strict'

  // Guard: only run on documents page
  const pageType = document.body.getAttribute('data-page-type')
  if (pageType !== 'documents') {
    return
  }

  const ns = window[Symbol.for('meander:pages')]
  let btn = undefined
  let dropdown = undefined

  /* ------------------------------------------------------------------ */
  /*  SVG Icon                                                           */
  /* ------------------------------------------------------------------ */

  function createIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '20')
    svg.setAttribute('height', '20')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')

    // List/outline icon - three horizontal lines
    const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line1.setAttribute('x1', '3')
    line1.setAttribute('y1', '6')
    line1.setAttribute('x2', '21')
    line1.setAttribute('y2', '6')
    svg.appendChild(line1)

    const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line2.setAttribute('x1', '3')
    line2.setAttribute('y1', '12')
    line2.setAttribute('x2', '21')
    line2.setAttribute('y2', '12')
    svg.appendChild(line2)

    const line3 = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line3.setAttribute('x1', '3')
    line3.setAttribute('y1', '18')
    line3.setAttribute('x2', '21')
    line3.setAttribute('y2', '18')
    svg.appendChild(line3)

    return svg
  }

  /* ------------------------------------------------------------------ */
  /*  Button Creation                                                    */
  /* ------------------------------------------------------------------ */

  function createTocButton() {
    const button = document.createElement('button')
    button.className = 'doc-toc-btn'
    button.type = 'button'
    button.setAttribute('aria-label', 'Table of Contents')
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-controls', 'mdr-doc-toc-dropdown')
    button.appendChild(createIcon())
    button.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleTocDropdown()
    })
    document.body.appendChild(button)
    return button
  }

  /* ------------------------------------------------------------------ */
  /*  Dropdown Creation                                                  */
  /* ------------------------------------------------------------------ */

  function createTocDropdown() {
    const el = document.createElement('div')
    el.className = 'doc-toc-dropdown'
    el.id = 'mdr-doc-toc-dropdown'
    el.setAttribute('role', 'menu')
    el.setAttribute('aria-label', 'Table of contents')
    el.style.display = 'none'

    // Header
    const header = document.createElement('div')
    header.className = 'doc-toc-dropdown-header'
    header.textContent = 'Table of Contents'
    el.appendChild(header)

    // List container
    const list = document.createElement('div')
    list.className = 'doc-toc-list'
    el.appendChild(list)

    document.body.appendChild(el)
    return el
  }

  /* ------------------------------------------------------------------ */
  /*  Dropdown Visibility                                                */
  /* ------------------------------------------------------------------ */

  function isDropdownOpen() {
    return !!(dropdown && dropdown.style.display !== 'none')
  }

  function openTocDropdown() {
    if (!dropdown) {
      dropdown = createTocDropdown()
    }
    if (ns?.popovers) {
      ns.popovers.openExclusive(closeTocDropdown)
    }
    populateToc()
    dropdown.style.display = 'flex'
    setExpanded(true)
  }

  function toggleTocDropdown() {
    if (isDropdownOpen()) {
      closeTocDropdown()
      return
    }
    openTocDropdown()
  }

  function closeTocDropdown() {
    if (dropdown) {
      dropdown.style.display = 'none'
    }
    setExpanded(false)
  }

  function setExpanded(value) {
    if (btn) {
      btn.setAttribute('aria-expanded', value ? 'true' : 'false')
    }
  }

  if (ns?.popovers) {
    ns.popovers.register(closeTocDropdown)
  }

  /* ------------------------------------------------------------------ */
  /*  TOC Population                                                     */
  /* ------------------------------------------------------------------ */

  function populateToc() {
    const activePane = document.querySelector('.doc-tab-pane.active')
    if (!activePane) {
      return
    }

    const docFile = activePane.getAttribute('data-doc-file')
    if (!docFile || !window[Symbol.for('meander:toc')]) {
      return
    }

    const docData = window[Symbol.for('meander:toc')].find(function (d) {
      return d.file === docFile
    })
    if (!docData) {
      return
    }

    const list = dropdown.querySelector('.doc-toc-list')
    list.innerHTML = ''

    for (let i = 0; i < docData.headings.length; i++) {
      const h = docData.headings[i]
      const item = document.createElement('a')
      item.className = 'doc-toc-item doc-toc-h' + h.level
      item.setAttribute('role', 'menuitem')
      item.href = '#' + h.id
      item.textContent = h.text

      // Capture heading ID in closure
      ;(function (headingId) {
        item.addEventListener('click', function (e) {
          e.preventDefault()
          const target = document.getElementById(headingId)
          if (target) {
            const topbar = document.querySelector('.topbar')
            const offset = topbar
              ? topbar.getBoundingClientRect().height + 16
              : 16
            const y =
              target.getBoundingClientRect().top + window.scrollY - offset
            const reduce =
              window.matchMedia &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches
            window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' })
          }
          closeTocDropdown()
        })
      })(h.id)

      list.appendChild(item)
    }

    // Update scroll spy immediately after populating
    updateScrollSpy()
  }

  /* ------------------------------------------------------------------ */
  /*  Scroll Spy                                                         */
  /* ------------------------------------------------------------------ */

  function updateScrollSpy() {
    if (!dropdown || dropdown.style.display === 'none') {
      return
    }

    const activePane = document.querySelector('.doc-tab-pane.active')
    if (!activePane) {
      return
    }

    // Get all headings with IDs within the active pane
    const headings = activePane.querySelectorAll(
      'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]',
    )
    if (headings.length === 0) {
      return
    }

    const topbar = document.querySelector('.topbar')
    const offset = topbar ? topbar.getBoundingClientRect().height + 20 : 20

    // Find the current heading (last one above the offset line)
    let current = undefined
    for (let i = 0; i < headings.length; i++) {
      const rect = headings[i].getBoundingClientRect()
      if (rect.top <= offset) {
        current = headings[i]
      }
    }

    // Update active state on TOC items
    const items = dropdown.querySelectorAll('.doc-toc-item')
    for (let j = 0; j < items.length; j++) {
      items[j].classList.remove('active')
      if (current && items[j].getAttribute('href') === '#' + current.id) {
        items[j].classList.add('active')
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Initialization                                                     */
  /* ------------------------------------------------------------------ */

  function activeDocHasHeadings() {
    const activePane = document.querySelector('.doc-tab-pane.active')
    if (!activePane || !window[Symbol.for('meander:toc')]) {
      return false
    }
    const docFile = activePane.getAttribute('data-doc-file')
    const docData = window[Symbol.for('meander:toc')].find(function (d) {
      return d.file === docFile
    })
    return !!(docData && docData.headings.length > 0)
  }

  function updateButtonVisibility() {
    if (!btn) {
      return
    }
    btn.style.display = activeDocHasHeadings() ? '' : 'none'
  }

  function init() {
    btn = createTocButton()
    updateButtonVisibility()

    /* Pre-create the dropdown so keyboard binding has a panel to
     * attach to before the user's first click. populateToc()
     * still runs lazily on each open so heading lists stay
     * fresh across tab changes. */
    if (ns?.popovers && ns.popovers.bindKeyboard) {
      if (!dropdown) {
        dropdown = createTocDropdown()
      }
      ns.popovers.bindKeyboard({
        trigger: btn,
        panel: dropdown,
        itemSelector: '.doc-toc-item',
        isOpen: isDropdownOpen,
        open: openTocDropdown,
        close: closeTocDropdown,
      })
    }

    // Listen for tab changes to repopulate TOC and update button visibility
    document.addEventListener('doctabchange', function () {
      updateButtonVisibility()
      // Close the dropdown if the new tab has no headings
      if (!activeDocHasHeadings()) {
        closeTocDropdown()
      } else if (dropdown && dropdown.style.display !== 'none') {
        populateToc()
      }
    })

    // Close dropdown when clicking outside
    document.addEventListener('click', function (e) {
      if (!dropdown) {
        return
      }
      const isClickInside =
        dropdown.contains(e.target) || btn.contains(e.target)
      if (!isClickInside) {
        closeTocDropdown()
      }
    })

    // Scroll spy
    window.addEventListener('scroll', updateScrollSpy, { passive: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
