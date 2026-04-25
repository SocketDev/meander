;(function () {
  'use strict'

  // Only activate on the documents page
  if (document.body.getAttribute('data-page-type') !== 'documents') {return}

  let anchor = null // { pane, blockId }
  let currentSelection = [] // array of .doc-block elements

  // Expose selection state and API for comment-client.js
  window.walkthroughSelection = null
  window.walkthroughSelectRange = function (pane, fromBlock, toBlock) {
    selectBlockRange(
      pane,
      pane.getAttribute('data-doc-file'),
      fromBlock,
      toBlock,
    )
  }

  function clearSelection() {
    for (let i = 0; i < currentSelection.length; i++) {
      currentSelection[i].classList.remove('block-selected')
    }
    currentSelection = []
    window.walkthroughSelection = null
    document.dispatchEvent(new CustomEvent('walkthroughselectionchange'))
  }

  function selectBlockRange(pane, file, fromId, toId) {
    const lo = Math.min(fromId, toId)
    const hi = Math.max(fromId, toId)
    clearSelection()

    const blocks = pane.querySelectorAll('.doc-block')
    for (let i = 0; i < blocks.length; i++) {
      const id = parseInt(blocks[i].getAttribute('data-block-id'), 10)
      if (id >= lo && id <= hi) {
        blocks[i].classList.add('block-selected')
        currentSelection.push(blocks[i])
      }
    }

    window.walkthroughSelection = {
      file: file,
      from: lo,
      to: hi,
      type: 'block',
    }
    document.dispatchEvent(new CustomEvent('walkthroughselectionchange'))
    updateHash(file, lo, hi)
  }

  function updateHash(file, lo, hi) {
    let hash = '#' + encodeURIComponent(file) + ':B' + lo
    if (lo !== hi) {hash += '-B' + hi}
    if (history.replaceState) {
      history.replaceState(null, '', hash)
    }
  }

  // Match #<encoded-filepath>:B28 or #<encoded-filepath>:B28-B35
  function parseHash() {
    const hash = window.location.hash
    if (!hash) {return null}

    const colonIdx = hash.lastIndexOf(':')
    if (colonIdx < 1) {return null}

    const filePart = decodeURIComponent(hash.substring(1, colonIdx))
    const blocksPart = hash.substring(colonIdx + 1)

    const match = blocksPart.match(/^B(\d+)(?:-B(\d+))?$/)
    if (!match) {return null}

    const from = parseInt(match[1], 10)
    const to = match[2] ? parseInt(match[2], 10) : from
    return { file: filePart, from: from, to: to }
  }

  function findPaneForFile(filePath) {
    const panes = document.querySelectorAll(
      '.doc-tab-pane[data-doc-file="' + CSS.escape(filePath) + '"]',
    )
    return panes.length > 0 ? panes[0] : null
  }

  document.addEventListener('click', function (e) {
    // Ignore clicks on comment UI elements
    if (
      e.target.closest('.comment-add-btn') ||
      e.target.closest('.comment-form-container') ||
      e.target.closest('.comment-card') ||
      e.target.closest('.doc-comment-container') ||
      e.target.closest('.comment-indicator')
    )
      {return}

    let block = e.target.closest('.doc-block')
    const gutter = e.target.closest('.doc-block-gutter')

    if (!block && !gutter) {
      // Click outside blocks — clear selection
      if (currentSelection.length > 0) {
        clearSelection()
        anchor = null
        if (history.replaceState) {
          history.replaceState(
            null,
            '',
            window.location.pathname + window.location.search,
          )
        }
      }
      return
    }

    if (gutter) {
      block = gutter.closest('.doc-block')
    }
    if (!block) {return}

    const pane = block.closest('.doc-tab-pane')
    if (!pane) {return}

    const blockId = parseInt(block.getAttribute('data-block-id'), 10)
    const file = pane.getAttribute('data-doc-file')

    if (e.shiftKey && anchor && anchor.pane === pane) {
      // Shift+click: select range from anchor to clicked block
      e.preventDefault()
      selectBlockRange(pane, file, anchor.blockId, blockId)
    } else {
      // Single click: set new anchor, select single block
      clearSelection()
      block.classList.add('block-selected')
      currentSelection = [block]
      anchor = { pane: pane, blockId: blockId }
      window.walkthroughSelection = {
        file: file,
        from: blockId,
        to: blockId,
        type: 'block',
      }
      document.dispatchEvent(new CustomEvent('walkthroughselectionchange'))
      updateHash(file, blockId, blockId)
    }
  })

  // On page load, apply selection from URL hash
  function applyHashSelection() {
    const range = parseHash()
    if (!range) {return}

    const pane = findPaneForFile(range.file)
    if (!pane) {return}

    // Ensure the pane is visible (switch tabs if necessary).
    // Use the public API from doc-tabs.js to avoid double scroll/hash handling.
    const docIndex = parseInt(pane.getAttribute('data-doc-index'), 10)
    if (!isNaN(docIndex) && !pane.classList.contains('active')) {
      if (typeof window.switchDocTab === 'function') {
        window.switchDocTab(docIndex)
      }
    }

    selectBlockRange(pane, range.file, range.from, range.to)

    // Scroll the first selected block into view, accounting for the sticky topbar.
    if (currentSelection.length > 0) {
      const topbar = document.querySelector('.topbar')
      const offset = topbar ? topbar.getBoundingClientRect().height + 16 : 16
      const y =
        currentSelection[0].getBoundingClientRect().top +
        window.scrollY -
        offset
      const reduce =
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyHashSelection)
  } else {
    applyHashSelection()
  }

  window.addEventListener('hashchange', function () {
    clearSelection()
    anchor = null
    applyHashSelection()
  })
})()
