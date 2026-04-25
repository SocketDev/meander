;(function () {
  'use strict'

  let anchor = null // { table, row, lineNum }
  let currentSelection = [] // array of <tr> elements

  // Expose selection state and API for comment-client.js
  window.walkthroughSelection = null
  window.walkthroughSelectRange = function (table, fromLine, toLine) {
    selectRange(table, fromLine, toLine)
  }

  function getLineNum(td) {
    return parseInt(td.textContent, 10) || 0
  }

  function getFilePath(table) {
    return table.getAttribute('data-file') || ''
  }

  function getTableRows(table) {
    return Array.from(table.querySelectorAll('tbody tr, tr'))
  }

  function clearSelection() {
    for (let i = 0; i < currentSelection.length; i++) {
      currentSelection[i].classList.remove('selected')
    }
    currentSelection = []
    window.walkthroughSelection = null
    document.dispatchEvent(new CustomEvent('walkthroughselectionchange'))
  }

  function selectRange(table, fromLine, toLine) {
    const lo = Math.min(fromLine, toLine)
    const hi = Math.max(fromLine, toLine)
    const rows = getTableRows(table)

    clearSelection()

    for (let i = 0; i < rows.length; i++) {
      const numCell = rows[i].querySelector('.line-num')
      if (!numCell) {continue}
      const num = getLineNum(numCell)
      if (num >= lo && num <= hi) {
        rows[i].classList.add('selected')
        currentSelection.push(rows[i])
      }
    }

    window.walkthroughSelection = {
      file: getFilePath(table),
      from: lo,
      to: hi,
      table: table,
    }
    document.dispatchEvent(new CustomEvent('walkthroughselectionchange'))
    updateHash(table, lo, hi)
  }

  function updateHash(table, lo, hi) {
    const file = encodeURIComponent(getFilePath(table))
    const lines = lo === hi ? 'L' + lo : 'L' + lo + '-L' + hi
    const hash = '#' + file + ':' + lines
    if (history.replaceState) {
      history.replaceState(null, '', hash)
    }
  }

  // Match #<encoded-filepath>:L28 or #<encoded-filepath>:L28-L35
  function parseHash() {
    const hash = window.location.hash
    if (!hash) {return null}

    const colonIdx = hash.lastIndexOf(':')
    if (colonIdx < 1) {return null}

    const filePart = decodeURIComponent(hash.substring(1, colonIdx))
    const linesPart = hash.substring(colonIdx + 1)

    const match = linesPart.match(/^L(\d+)(?:-L(\d+))?$/)
    if (!match) {return null}

    const from = parseInt(match[1], 10)
    const to = match[2] ? parseInt(match[2], 10) : from
    return { file: filePart, from: from, to: to }
  }

  function findTableForFile(filePath) {
    const tables = document.querySelectorAll(
      '.code-table[data-file="' + CSS.escape(filePath) + '"]',
    )
    // May have multiple tables for the same file (multiple sections); find the one containing the line
    return tables
  }

  function findTableForFileAndLine(filePath, lineNum) {
    const tables = findTableForFile(filePath)
    for (let i = 0; i < tables.length; i++) {
      const rows = getTableRows(tables[i])
      for (let j = 0; j < rows.length; j++) {
        const numCell = rows[j].querySelector('.line-num')
        if (numCell && getLineNum(numCell) === lineNum) {
          return tables[i]
        }
      }
    }
    return null
  }

  document.addEventListener('click', function (e) {
    // Ignore clicks on comment indicators
    if (e.target.closest('.comment-indicator')) {return}

    const td = e.target.closest('.line-num')

    if (!td) {
      // Click outside line numbers — clear selection (but not if clicking comment UI)
      if (
        currentSelection.length > 0 &&
        !e.target.closest('.code-table') &&
        !e.target.closest('.comment-add-btn') &&
        !e.target.closest('.comment-form-container') &&
        !e.target.closest('.comment-form-row') &&
        !e.target.closest('.comment-row') &&
        !e.target.closest('.comment-card')
      ) {
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

    const tr = td.closest('tr')
    const table = td.closest('.code-table')
    if (!tr || !table) {return}

    const lineNum = getLineNum(td)
    if (!lineNum) {return}

    if (e.shiftKey && anchor && anchor.table === table) {
      // Shift+click: extend range from anchor
      e.preventDefault() // suppress Safari's text selection
      selectRange(table, anchor.lineNum, lineNum)
    } else {
      // Single click: set new anchor
      clearSelection()
      tr.classList.add('selected')
      currentSelection.push(tr)
      anchor = { table: table, row: tr, lineNum: lineNum }
      window.walkthroughSelection = {
        file: getFilePath(table),
        from: lineNum,
        to: lineNum,
        table: table,
      }
      document.dispatchEvent(new CustomEvent('walkthroughselectionchange'))
      updateHash(table, lineNum, lineNum)
    }
  })

  // On page load, apply selection from URL hash
  function applyHashSelection() {
    const range = parseHash()
    if (!range) {return}

    const table = findTableForFileAndLine(range.file, range.from)
    if (!table) {return}

    selectRange(table, range.from, range.to)

    // Scroll the first selected row into view
    if (currentSelection.length > 0) {
      const reduce =
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      currentSelection[0].scrollIntoView({
        behavior: reduce ? 'auto' : 'smooth',
        block: 'center',
      })
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
