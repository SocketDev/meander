;(function () {
  'use strict'

  // Guard: only run on documents page
  const pageType = document.body.getAttribute('data-page-type')
  if (pageType !== 'documents') {
    return
  }

  /* ------------------------------------------------------------------ */
  /*  Tab Switching                                                      */
  /* ------------------------------------------------------------------ */

  function switchToTab(index, updateHash) {
    const tabs = document.querySelectorAll('.doc-tab-btn')
    const panes = document.querySelectorAll('.doc-tab-pane')

    for (let i = 0; i < tabs.length; i++) {
      const isActive = i === index
      tabs[i].classList.toggle('active', isActive)
      panes[i].classList.toggle('active', isActive)
      panes[i].style.display = isActive ? 'block' : 'none'
    }

    // Update URL hash
    if (updateHash !== false) {
      const pane = panes[index]
      if (pane) {
        const filePath = pane.getAttribute('data-doc-file')
        if (filePath && history.replaceState) {
          history.replaceState(
            undefined,
            '',
            '#' + encodeURIComponent(filePath),
          )
        }
      }
    }

    // Fire custom event for TOC to listen to
    document.dispatchEvent(
      new CustomEvent('doctabchange', { detail: { index: index } }),
    )
  }

  // Expose for programmatic tab switching
  window.switchDocTab = function (index) {
    switchToTab(index, true)
  }

  /* ------------------------------------------------------------------ */
  /*  Hash Parsing                                                       */
  /* ------------------------------------------------------------------ */

  // Hash format:
  // #<encoded-file-path>                    - tab selection only
  // #<encoded-file-path>:<heading-id>      - tab + scroll to heading
  // #<encoded-file-path>:B<n>              - tab + scroll to block
  // #<encoded-file-path>:B<n>-B<m>         - tab + block range selection
  function parseHash() {
    let hash = window.location.hash
    if (!hash || hash.length < 2) {
      return undefined
    }

    // Remove leading #
    hash = hash.substring(1)

    // Find the colon separator (if any)
    const colonIdx = hash.lastIndexOf(':')

    let filePath
    let anchor = ''

    if (colonIdx > 0) {
      // Has anchor part
      filePath = hash.substring(0, colonIdx)
      anchor = hash.substring(colonIdx + 1)
    } else {
      // No anchor, just file path
      filePath = hash
    }

    // Decode the file path
    try {
      filePath = decodeURIComponent(filePath)
    } catch (_e) {
      return undefined
    }

    return { filePath: filePath, anchor: anchor }
  }

  function findTabIndexByFilePath(filePath) {
    const panes = document.querySelectorAll('.doc-tab-pane')
    for (let i = 0; i < panes.length; i++) {
      if (panes[i].getAttribute('data-doc-file') === filePath) {
        return i
      }
    }
    return -1
  }

  /* ------------------------------------------------------------------ */
  /*  Scroll to Target                                                   */
  /* ------------------------------------------------------------------ */

  // Scroll an element into view below the sticky topbar.
  function scrollBelowTopbar(el) {
    const topbar = document.querySelector('.topbar')
    const offset = topbar ? topbar.getBoundingClientRect().height + 16 : 16
    const y = el.getBoundingClientRect().top + window.scrollY - offset
    const reduce =
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' })
  }

  function scrollToTarget(anchor) {
    if (!anchor) {
      return
    }

    // Check if it's a heading ID (not starting with B)
    if (!anchor.startsWith('B')) {
      const heading = document.getElementById(anchor)
      if (heading) {
        scrollBelowTopbar(heading)
      }
      return
    }

    // Check for block ID: B<n> or B<n>-B<m>
    const blockMatch = anchor.match(/^B(\d+)(?:-B(\d+))?$/)
    if (blockMatch) {
      const blockId = blockMatch[1]
      const block = document.querySelector(
        '.doc-tab-pane.active .doc-block[data-block-id="' + blockId + '"]',
      )
      if (block) {
        scrollBelowTopbar(block)
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Apply Hash on Load/Change                                          */
  /* ------------------------------------------------------------------ */

  function applyHash() {
    const parsed = parseHash()
    if (!parsed) {
      return
    }

    const index = findTabIndexByFilePath(parsed.filePath)
    if (index < 0) {
      return
    }

    // Switch to the tab without updating hash (we're reading from hash)
    switchToTab(index, false)

    // Scroll to anchor if present
    if (parsed.anchor) {
      // Small delay to allow DOM to settle after tab switch
      setTimeout(function () {
        scrollToTarget(parsed.anchor)
      }, 50)
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Event Handlers                                                     */
  /* ------------------------------------------------------------------ */

  // Tab button click handler
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('.doc-tab-btn')
    if (!btn) {
      return
    }

    const index = parseInt(btn.getAttribute('data-doc-index'), 10)
    if (!isNaN(index)) {
      e.preventDefault()
      switchToTab(index, true)
    }
  })

  // Cross-reference link click handler
  document.addEventListener('click', function (e) {
    const link = e.target.closest('[data-doc-ref]')
    if (!link) {
      return
    }

    const index = parseInt(link.getAttribute('data-doc-ref'), 10)
    const anchor = link.getAttribute('data-doc-anchor') || ''

    if (!isNaN(index)) {
      e.preventDefault()

      // Update URL hash with file path and anchor
      const panes = document.querySelectorAll('.doc-tab-pane')
      const pane = panes[index]
      if (pane) {
        const filePath = pane.getAttribute('data-doc-file')
        if (filePath) {
          let hash = '#' + encodeURIComponent(filePath)
          if (anchor) {
            hash += ':' + anchor
          }
          if (history.pushState) {
            history.pushState(undefined, '', hash)
          }
        }
      }

      // Switch to the tab
      switchToTab(index, false)

      // Scroll to anchor if present
      if (anchor) {
        setTimeout(function () {
          scrollToTarget(anchor)
        }, 50)
      }
    }
  })

  // Hash change handler
  window.addEventListener('hashchange', function () {
    applyHash()
  })

  /* ------------------------------------------------------------------ */
  /*  Initialization                                                     */
  /* ------------------------------------------------------------------ */

  function init() {
    // Apply hash on load if present.
    // Skip block-reference hashes (e.g. #file.md:B5) — block-select.js owns those.
    const hash = window.location.hash
    if (hash && hash.length > 1 && !/:[Bb]\d/.test(hash)) {
      applyHash()
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
