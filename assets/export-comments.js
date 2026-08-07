;(function () {
  'use strict'

  const slug = document.body.getAttribute('data-slug')
  if (!slug) {
    return
  }

  const ns = window[Symbol.for('meander:pages')]
  let dropdown = undefined
  let status = undefined

  /* ------------------------------------------------------------------ */
  /*  Download                                                           */
  /* ------------------------------------------------------------------ */

  /* The export route is gated, and the session token rides on the
   * Authorization header that comment-client.js attaches. A plain
   * <a href> download is a top-level navigation, which cannot
   * carry that header, so request the JSON through the shared
   * session client and hand the response to a synthetic
   * object-URL anchor instead.
   */
  function download(url, filename) {
    const auth = ns?.auth
    if (!auth) {
      setStatus('Export needs the comment client, which did not load.')
      return Promise.resolve()
    }
    return auth
      .fetch(url)
      .then(function (response) {
        if (!response.ok) {
          return response
            .json()
            .catch(function () {
              return {}
            })
            .then(function (body) {
              throw new Error(
                body.error ||
                  'Export failed (' + response.status + '). Sign in and retry.',
              )
            })
        }
        return response.blob()
      })
      .then(function (blob) {
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(objectUrl)
        setStatus('')
        hideDropdown()
      })
      .catch(function (e) {
        setStatus(e.message)
      })
  }

  function setStatus(text) {
    if (status) {
      status.textContent = text
      status.style.display = text ? 'block' : 'none'
    }
  }

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

    el.appendChild(
      createOption(
        'Export All',
        '/' + slug + '/api/comments/export',
        slug + '-comments-all.json',
      ),
    )
    el.appendChild(
      createOption(
        'Export Unresolved',
        '/' + slug + '/api/comments/export?unresolved=true',
        slug + '-comments-unresolved.json',
      ),
    )

    status = document.createElement('div')
    status.className = 'export-dropdown-status'
    status.setAttribute('role', 'status')
    status.style.display = 'none'
    el.appendChild(status)

    document.body.appendChild(el)
    return el
  }

  /* Kept as an anchor with a real href: it stays keyboard-focusable
   * for the menu pattern and the URL is copyable. Activation is
   * intercepted so the request carries the session token.
   */
  function createOption(label, url, filename) {
    const option = document.createElement('a')
    option.className = 'export-option'
    option.setAttribute('role', 'menuitem')
    option.href = url
    option.textContent = label
    option.addEventListener('click', function (e) {
      e.preventDefault()
      setStatus('Exporting…')
      download(url, filename)
    })
    return option
  }

  function positionDropdown() {
    if (!dropdown) {
      return
    }
    const btn = document.querySelector('.export-btn')
    if (!btn) {
      return
    }

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
    if (ns?.popovers) {
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

  if (ns?.popovers) {
    ns.popovers.register(hideDropdown)
  }

  /* ------------------------------------------------------------------ */
  /*  Init                                                               */
  /* ------------------------------------------------------------------ */

  function init() {
    const topbar = document.querySelector('.topbar')
    if (!topbar) {
      return
    }

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
     * would no-op the menu keys until first click).
     */
    if (ns?.popovers && ns.popovers.bindKeyboard) {
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
    if (!dropdown) {
      return
    }
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
