;(function () {
  'use strict'

  const slug = document.body.getAttribute('data-slug')
  if (!slug) {return}

  const ns = window[Symbol.for('meander:pages')]
  let dropdown = null

  /* ------------------------------------------------------------------ */
  /*  SVG Icon                                                           */
  /* ------------------------------------------------------------------ */

  function createIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')

    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path1.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4')
    svg.appendChild(path1)

    const polyline = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'polyline',
    )
    polyline.setAttribute('points', '7 10 12 15 17 10')
    svg.appendChild(polyline)

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', '12')
    line.setAttribute('y1', '15')
    line.setAttribute('x2', '12')
    line.setAttribute('y2', '3')
    svg.appendChild(line)

    return svg
  }

  /* ------------------------------------------------------------------ */
  /*  Button                                                             */
  /* ------------------------------------------------------------------ */

  function createButton() {
    const btn = document.createElement('button')
    btn.className = 'export-btn'
    btn.title = 'Export comments'
    btn.type = 'button'
    btn.setAttribute('aria-label', 'Export comments')
    btn.setAttribute('aria-haspopup', 'menu')
    btn.setAttribute('aria-expanded', 'false')
    btn.setAttribute('aria-controls', 'mdr-export-dropdown')
    btn.appendChild(createIcon())

    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleDropdown()
    })

    return btn
  }

  /* ------------------------------------------------------------------ */
  /*  Dropdown                                                           */
  /* ------------------------------------------------------------------ */

  function createDropdown() {
    const el = document.createElement('div')
    el.className = 'export-dropdown'
    el.id = 'mdr-export-dropdown'
    el.setAttribute('role', 'menu')
    el.setAttribute('aria-label', 'Export comments')
    el.style.display = 'none'

    const header = document.createElement('div')
    header.className = 'export-dropdown-header'
    header.textContent = 'Export Comments'
    el.appendChild(header)

    const exportAll = document.createElement('a')
    exportAll.className = 'export-option'
    exportAll.setAttribute('role', 'menuitem')
    exportAll.href = '/' + slug + '/api/comments/export'
    exportAll.setAttribute('download', slug + '-comments-all.json')
    exportAll.textContent = 'Export All'
    el.appendChild(exportAll)

    const exportUnresolved = document.createElement('a')
    exportUnresolved.className = 'export-option'
    exportUnresolved.setAttribute('role', 'menuitem')
    exportUnresolved.href = '/' + slug + '/api/comments/export?unresolved=true'
    exportUnresolved.setAttribute(
      'download',
      slug + '-comments-unresolved.json',
    )
    exportUnresolved.textContent = 'Export Unresolved'
    el.appendChild(exportUnresolved)

    document.body.appendChild(el)
    return el
  }

  function positionDropdown() {
    if (!dropdown) {return}
    const btn = document.querySelector('.export-btn')
    if (!btn) {return}

    const btnRect = btn.getBoundingClientRect()
    const dropdownWidth = 200

    dropdown.style.position = 'fixed'
    dropdown.style.top = btnRect.bottom + 8 + 'px'
    dropdown.style.right = window.innerWidth - btnRect.right + 'px'
    dropdown.style.zIndex = '100'
    dropdown.style.width = dropdownWidth + 'px'
  }

  function isDropdownOpen() {
    return !!(dropdown && dropdown.style.display !== 'none')
  }

  function showDropdown() {
    if (!dropdown) {
      dropdown = createDropdown()
    }
    if (ns && ns.popovers) {
      ns.popovers.openExclusive(hideDropdown)
    }
    positionDropdown()
    dropdown.style.display = 'block'
    setExpanded(true)
  }

  function toggleDropdown() {
    if (isDropdownOpen()) {
      hideDropdown()
      return
    }
    showDropdown()
  }

  function hideDropdown() {
    if (dropdown) {
      dropdown.style.display = 'none'
    }
    setExpanded(false)
  }

  function setExpanded(value) {
    const btn = document.querySelector('.export-btn')
    if (btn) {
      btn.setAttribute('aria-expanded', value ? 'true' : 'false')
    }
  }

  if (ns && ns.popovers) {ns.popovers.register(hideDropdown)}

  /* ------------------------------------------------------------------ */
  /*  Init                                                               */
  /* ------------------------------------------------------------------ */

  function init() {
    const topbar = document.querySelector('.topbar')
    if (!topbar) {return}

    let actions = topbar.querySelector('.topbar-actions')
    if (!actions) {
      actions = document.createElement('div')
      actions.className = 'topbar-actions'
      topbar.appendChild(actions)
    }

    const btn = createButton()
    // Insert export button before the unresolved button (if it exists)
    const unresolvedBtn = actions.querySelector('.unresolved-btn')
    if (unresolvedBtn) {
      actions.insertBefore(btn, unresolvedBtn)
    } else {
      actions.appendChild(btn)
    }

    /* Bind keyboard once — pre-create the dropdown so the panel
     * exists for the keydown listener (binding to a null panel
     * would no-op the menu keys until first click). */
    if (ns && ns.popovers && ns.popovers.bindKeyboard) {
      if (!dropdown) {
        dropdown = createDropdown()
      }
      ns.popovers.bindKeyboard({
        trigger: btn,
        panel: dropdown,
        itemSelector: '.export-option',
        isOpen: isDropdownOpen,
        open: showDropdown,
        close: hideDropdown,
      })
    }
  }

  document.addEventListener('click', function (e) {
    if (!dropdown) {return}
    const btn = document.querySelector('.export-btn')
    const isClickInside = dropdown.contains(e.target) || btn.contains(e.target)
    if (!isClickInside) {
      hideDropdown()
    }
  })

  window.addEventListener('resize', function () {
    if (dropdown && dropdown.style.display !== 'none') {
      positionDropdown()
    }
  })

  window.addEventListener(
    'scroll',
    function () {
      hideDropdown()
    },
    { passive: true },
  )

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
