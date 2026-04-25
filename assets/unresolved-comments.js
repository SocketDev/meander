;(function () {
  'use strict'

  const slug = document.body.getAttribute('data-slug')
  if (!slug) {return}

  const ns = window[Symbol.for('meander:pages')]
  const apiBase = '/' + slug + '/api/comments/unresolved'
  let dropdown = null
  let unresolvedCount = 0

  /* Resolve a part id to its human title via the body's
   * data-part-titles map (emitted by generate.mts). Falls back
   * to "Marker N" when the title is missing — the bare number
   * is meaningless context-free, so the prefix is required.
   * "Documents" is part 0 by convention. */
  const partTitlesById = (function () {
    try {
      const raw = document.body.getAttribute('data-part-titles')
      if (!raw) {
        return {}
      }
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (_) {
      return {}
    }
  })()
  function partLabel(partId) {
    if (partId === 0) {return 'Documents'}
    const title = partTitlesById[String(partId)]
    return title || 'Marker ' + partId
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
    path1.setAttribute(
      'd',
      'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    )
    svg.appendChild(path1)

    return svg
  }

  /* ------------------------------------------------------------------ */
  /*  Button                                                             */
  /* ------------------------------------------------------------------ */

  function createButton() {
    const btn = document.createElement('button')
    btn.className = 'unresolved-btn'
    btn.type = 'button'
    btn.setAttribute('aria-label', 'View unresolved comments')
    btn.setAttribute('aria-haspopup', 'menu')
    btn.setAttribute('aria-expanded', 'false')
    btn.setAttribute('aria-controls', 'mdr-unresolved-dropdown')

    btn.appendChild(createIcon())

    const badge = document.createElement('span')
    badge.className = 'unresolved-badge'
    badge.style.display = 'none'
    btn.appendChild(badge)

    btn.addEventListener('click', function (e) {
      e.stopPropagation()
      toggleDropdown()
    })

    return btn
  }

  function updateBadge(count) {
    unresolvedCount = count
    const badge = document.querySelector('.unresolved-badge')
    if (!badge) {return}
    if (count > 0) {
      badge.textContent = count
      badge.style.display = 'inline-flex'
    } else {
      badge.style.display = 'none'
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Dropdown                                                           */
  /* ------------------------------------------------------------------ */

  function createDropdown() {
    const el = document.createElement('div')
    el.className = 'unresolved-dropdown'
    el.id = 'mdr-unresolved-dropdown'
    el.setAttribute('role', 'menu')
    el.setAttribute('aria-label', 'Unresolved comments')
    el.style.display = 'none'

    const header = document.createElement('div')
    header.className = 'unresolved-dropdown-header'
    header.textContent = 'Unresolved Comments'
    el.appendChild(header)

    const list = document.createElement('div')
    list.className = 'unresolved-list'
    el.appendChild(list)

    const empty = document.createElement('div')
    empty.className = 'unresolved-empty'
    empty.textContent = 'No unresolved comments'
    empty.style.display = 'none'
    el.appendChild(empty)

    document.body.appendChild(el)
    return el
  }

  function positionDropdown() {
    if (!dropdown) {return}
    const btn = document.querySelector('.unresolved-btn')
    if (!btn) {return}
    const rect = btn.getBoundingClientRect()
    dropdown.style.position = 'fixed'
    dropdown.style.top = rect.bottom + 8 + 'px'
    dropdown.style.right = window.innerWidth - rect.right + 'px'
  }

  function isDropdownOpen() {
    return !!(dropdown && dropdown.style.display !== 'none')
  }

  function openDropdown() {
    if (!dropdown) {
      dropdown = createDropdown()
    }
    if (ns && ns.popovers) {
      ns.popovers.openExclusive(closeDropdown)
    }
    positionDropdown()
    dropdown.style.display = 'block'
    setExpanded(true)
    fetchAndRenderComments()
  }

  function toggleDropdown() {
    if (isDropdownOpen()) {
      closeDropdown()
      return
    }
    openDropdown()
  }

  function closeDropdown() {
    if (dropdown) {
      dropdown.style.display = 'none'
    }
    setExpanded(false)
  }

  function setExpanded(value) {
    const btn = document.querySelector('.unresolved-btn')
    if (btn) {
      btn.setAttribute('aria-expanded', value ? 'true' : 'false')
    }
  }

  if (ns && ns.popovers) {ns.popovers.register(closeDropdown)}

  /* ------------------------------------------------------------------ */
  /*  API                                                                */
  /* ------------------------------------------------------------------ */

  function fetchAndRenderComments() {
    const list = dropdown.querySelector('.unresolved-list')
    const empty = dropdown.querySelector('.unresolved-empty')
    list.innerHTML =
      '<div class="unresolved-skeleton" aria-hidden="true">' +
      '<div class="unresolved-skel-row"><div class="unresolved-skel-line skel-1"></div><div class="unresolved-skel-line skel-2"></div></div>' +
      '<div class="unresolved-skel-row"><div class="unresolved-skel-line skel-1"></div><div class="unresolved-skel-line skel-2"></div></div>' +
      '<div class="unresolved-skel-row"><div class="unresolved-skel-line skel-1"></div><div class="unresolved-skel-line skel-2"></div></div>' +
      '</div>' +
      '<span class="visually-hidden" role="status">Loading unresolved comments…</span>'
    empty.style.display = 'none'

    fetch(apiBase, {
      signal:
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10000)
          : undefined,
    })
      .then(function (r) {
        return r.json()
      })
      .then(function (comments) {
        updateBadge(comments.length)
        renderComments(comments)
      })
      .catch(function (err) {
        console.error('Failed to fetch unresolved comments:', err)
        list.innerHTML = '<div class="unresolved-error">Failed to load</div>'
      })
  }

  /* ------------------------------------------------------------------ */
  /*  Rendering                                                          */
  /* ------------------------------------------------------------------ */

  function renderComments(comments) {
    const list = dropdown.querySelector('.unresolved-list')
    const empty = dropdown.querySelector('.unresolved-empty')
    list.innerHTML = ''

    if (comments.length === 0) {
      empty.style.display = 'block'
      return
    }

    const grouped = {}
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i]
      const key = partLabel(c.part)
      if (!grouped[key]) {grouped[key] = []}
      grouped[key].push(c)
    }

    const groupKeys = Object.keys(grouped)
    for (let p = 0; p < groupKeys.length; p++) {
      const groupKey = groupKeys[p]
      const partComments = grouped[groupKey]

      const groupHeader = document.createElement('div')
      groupHeader.className = 'unresolved-group-header'
      groupHeader.textContent = groupKey + ' (' + partComments.length + ')'
      list.appendChild(groupHeader)

      for (let j = 0; j < partComments.length; j++) {
        const comment = partComments[j]
        const item = createCommentItem(comment)
        list.appendChild(item)
      }
    }
  }

  function createCommentItem(comment) {
    const item = document.createElement('a')
    item.className = 'unresolved-item'
    item.setAttribute('role', 'menuitem')
    let range
    if (comment.part === 0) {
      range =
        comment.lineFrom === comment.lineTo
          ? 'B' + comment.lineFrom
          : 'B' + comment.lineFrom + '-B' + comment.lineTo
      item.href =
        '/' +
        slug +
        '/documents#' +
        encodeURIComponent(comment.file) +
        ':' +
        range
    } else {
      range =
        comment.lineFrom === comment.lineTo
          ? 'L' + comment.lineFrom
          : 'L' + comment.lineFrom + '-L' + comment.lineTo
      item.href =
        '/' +
        slug +
        '/part/' +
        comment.part +
        '#' +
        encodeURIComponent(comment.file) +
        ':' +
        range
    }

    const fileLine = document.createElement('div')
    fileLine.className = 'unresolved-item-file'
    fileLine.textContent = comment.file + ' ' + range

    const author = document.createElement('span')
    author.className = 'unresolved-item-author'
    author.textContent = comment.author

    const preview = document.createElement('div')
    preview.className = 'unresolved-item-preview'
    preview.textContent = truncate(comment.body, 80)

    const meta = document.createElement('div')
    meta.className = 'unresolved-item-meta'
    meta.appendChild(author)
    meta.appendChild(document.createTextNode(' \u00b7 '))
    meta.appendChild(document.createTextNode(formatTime(comment.createdAt)))

    item.appendChild(fileLine)
    item.appendChild(preview)
    item.appendChild(meta)

    item.addEventListener('click', function (e) {
      e.preventDefault()
      window.location.href = item.href
    })

    return item
  }

  function truncate(str, max) {
    if (str.length <= max) {return str}
    return str.substring(0, max - 3) + '...'
  }

  function formatTime(iso) {
    try {
      const d = new Date(iso)
      const now = new Date()
      const diffMs = now - d
      const diffMins = Math.floor(diffMs / 60000)
      const diffHours = Math.floor(diffMs / 3600000)
      const diffDays = Math.floor(diffMs / 86400000)

      if (diffMins < 1) {return 'just now'}
      if (diffMins < 60) {return diffMins + 'm ago'}
      if (diffHours < 24) {return diffHours + 'h ago'}
      if (diffDays < 7) {return diffDays + 'd ago'}
      return d.toLocaleDateString()
    } catch (_) {
      return iso
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Initialization                                                     */
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
    actions.appendChild(btn)

    /* Lazily wire keyboard once the dropdown DOM exists. The
     * panel is created on first open, so we bind on the next
     * tick after the click handler creates it. The trigger key
     * bindings live on the button regardless. */
    if (ns && ns.popovers && ns.popovers.bindKeyboard) {
      const lazyBind = () => {
        if (!dropdown) {
          dropdown = createDropdown()
        }
        ns.popovers.bindKeyboard({
          trigger: btn,
          panel: dropdown,
          itemSelector: '.unresolved-item',
          isOpen: isDropdownOpen,
          open: openDropdown,
          close: closeDropdown,
        })
      }
      lazyBind()
    }

    // Load unresolved comments count
    loadUnresolved()

    // Hide dropdown when clicking outside
    document.addEventListener('click', function (e) {
      if (!dropdown) {return}
      const btn = document.querySelector('.unresolved-btn')
      const isClickInside = dropdown.contains(e.target) || btn.contains(e.target)
      if (!isClickInside) {
        closeDropdown()
      }
    })

    // Reposition dropdown on resize
    window.addEventListener(
      'resize',
      function () {
        if (dropdown && dropdown.style.display !== 'none') {
          positionDropdown()
        }
      },
      { passive: true },
    )
  }

  function loadUnresolved() {
    fetch(apiBase, {
      signal:
        typeof AbortSignal !== 'undefined' &&
        typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(10000)
          : undefined,
    })
      .then(function (r) {
        return r.json()
      })
      .then(function (comments) {
        updateBadge(comments.length)
      })
      .catch(function () {
        /* silently fail */
      })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
