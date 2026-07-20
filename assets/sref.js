;(function () {
  'use strict'

  /* Symbol table: window[Symbol.for("meander:syms")] maps each
   * exported name to an array of locations. Each location is a
   * 3-tuple [file, line, part] — fields are positional (index
   * 0/1/2) so the inlined JSON stays compact. The array shape
   * lets us preserve overloads (same name, different lines in
   * one file) and cross-file duplicates (e.g. a `parse` func
   * in several ecosystem-specific files) instead of silently
   * dropping them like the old singleton shape did. */
  const symbols = window[Symbol.for('meander:syms')]
  if (!symbols || typeof symbols !== 'object') {
    return
  }

  const slug = document.body.getAttribute('data-slug')
  if (!slug) {
    return
  }

  const names = Object.keys(symbols).toSorted(function (a, b) {
    return b.length - a.length // longest first to avoid partial matches
  })
  if (names.length === 0) {
    return
  }

  // Build a regex that matches any definition name as a whole word
  const escaped = names.map(function (n) {
    return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })
  const pattern = new RegExp('\\b(' + escaped.join('|') + ')\\b', 'g')

  // Tuple field accessors — one place to change if the shape evolves.
  function locFile(loc) {
    return loc[0]
  }
  function locLine(loc) {
    return loc[1]
  }
  function locPart(loc) {
    return loc[2]
  }

  // Process all highlighted code elements — runs after highlight.js
  function processCodeElements() {
    const codeEls = document.querySelectorAll('.line-code code')
    for (let i = 0; i < codeEls.length; i++) {
      processNode(codeEls[i])
    }
  }

  /* True when the match is the name at its own definition
   * line/file — we don't wrap those (a symbol shouldn't link
   * to itself). Checks against every location in `locs`. */
  function isSelfReference(textNode, locs) {
    let table = textNode.closest ? textNode.closest('.code-table') : undefined
    if (!table) {
      let el = textNode.parentElement
      while (el && !el.classList.contains('code-table')) {
        el = el.parentElement
      }
      table = el
    }
    if (!table) {
      return false
    }
    const currentFile = table.getAttribute('data-file')
    let row = textNode.parentElement
    while (row && row.tagName !== 'TR') {
      row = row.parentElement
    }
    if (!row) {
      return false
    }
    const lineCell = row.querySelector('.line-num')
    if (!lineCell) {
      return false
    }
    const currentLine = parseInt(lineCell.textContent, 10)
    for (let i = 0; i < locs.length; i++) {
      if (
        locFile(locs[i]) === currentFile &&
        locLine(locs[i]) === currentLine
      ) {
        return true
      }
    }
    return false
  }

  function processNode(node) {
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_TEXT,
      undefined,
    )
    const textNodes = []
    let current
    while ((current = walker.nextNode())) {
      textNodes.push(current)
    }

    for (let i = 0; i < textNodes.length; i++) {
      const textNode = textNodes[i]
      const text = textNode.textContent
      if (!text) {
        continue
      }

      if (
        textNode.parentElement &&
        textNode.parentElement.classList.contains('def-ref')
      ) {
        continue
      }

      const parts = []
      let lastIndex = 0
      let match
      pattern.lastIndex = 0

      while ((match = pattern.exec(text)) !== null) {
        const name = match[1]
        const locs = symbols[name]
        if (!locs || locs.length === 0) {
          continue
        }
        if (isSelfReference(textNode, locs)) {
          continue
        }

        if (match.index > lastIndex) {
          parts.push(
            document.createTextNode(text.slice(lastIndex, match.index)),
          )
        }

        /* Stash locs on the span. Single-location uses flat
         * data-* attrs (cheaper to read than JSON.parse). Multi-
         * location packs into one JSON attr so click + tooltip
         * handlers can route without re-reading `symbols`. */
        const span = document.createElement('span')
        span.className = 'def-ref'
        span.setAttribute('data-def-name', name)
        if (locs.length === 1) {
          const only = locs[0]
          span.setAttribute('data-def-file', locFile(only))
          span.setAttribute('data-def-line', locLine(only))
          span.setAttribute('data-def-part', locPart(only))
        } else {
          span.setAttribute('data-def-count', locs.length)
          span.setAttribute('data-def-locs', JSON.stringify(locs))
        }
        span.textContent = name
        parts.push(span)

        lastIndex = match.index + match[0].length
      }

      if (parts.length === 0) {
        continue
      }

      if (lastIndex < text.length) {
        parts.push(document.createTextNode(text.slice(lastIndex)))
      }

      const parent = textNode.parentNode
      for (let j = 0; j < parts.length; j++) {
        parent.insertBefore(parts[j], textNode)
      }
      parent.removeChild(textNode)
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Tooltip                                                            */
  /* ------------------------------------------------------------------ */

  let tooltip = undefined

  function createTooltip() {
    const el = document.createElement('div')
    el.className = 'def-tooltip'
    el.style.display = 'none'
    document.body.appendChild(el)
    return el
  }

  function locsFromSpan(span) {
    const packed = span.getAttribute('data-def-locs')
    if (packed) {
      try {
        return JSON.parse(packed)
      } catch {
        return []
      }
    }
    const file = span.getAttribute('data-def-file')
    const line = span.getAttribute('data-def-line')
    const part = span.getAttribute('data-def-part')
    if (!file) {
      return []
    }
    return [[file, parseInt(line, 10), parseInt(part, 10)]]
  }

  function showTooltip(span) {
    if (!tooltip) {
      tooltip = createTooltip()
    }
    const name = span.getAttribute('data-def-name')
    const locs = locsFromSpan(span)

    const header = '<div class="def-tooltip-name">' + name + '</div>'
    if (locs.length === 1) {
      const loc = locs[0]
      tooltip.innerHTML =
        header +
        '<div class="def-tooltip-location">' +
        locFile(loc) +
        ':' +
        locLine(loc) +
        ' (Part ' +
        locPart(loc) +
        ')</div>' +
        '<div class="def-tooltip-hint">Click symbol to go to definition</div>'
    } else {
      const items = locs
        .map(function (loc) {
          return (
            '<div class="def-tooltip-location">' +
            locFile(loc) +
            ':' +
            locLine(loc) +
            ' (Part ' +
            locPart(loc) +
            ')</div>'
          )
        })
        .join('')
      tooltip.innerHTML =
        header +
        items +
        '<div class="def-tooltip-hint">Click to pick a location (' +
        locs.length +
        ' defined)</div>'
    }

    const rect = span.getBoundingClientRect()
    tooltip.style.display = 'block'
    tooltip.style.left = rect.left + 'px'
    tooltip.style.top = rect.bottom + 4 + 'px'
  }

  function hideTooltip() {
    if (tooltip) {
      tooltip.style.display = 'none'
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Event listeners                                                    */
  /* ------------------------------------------------------------------ */

  function navigateTo(loc) {
    const hash = '#' + encodeURIComponent(locFile(loc)) + ':L' + locLine(loc)
    const currentPart = document.body.getAttribute('data-part')
    if (String(locPart(loc)) === currentPart) {
      window.location.hash = hash
    } else {
      window.location.href = '/' + slug + '/part/' + locPart(loc) + hash
    }
  }

  /* Minimal disambiguator: browser-native prompt picks the
   * location number. Keeps the asset script dep-free. Consumers
   * that want a fancier popup can override by listening to the
   * click earlier and calling preventDefault(). */
  function pickLocation(locs) {
    if (locs.length === 1) {
      return locs[0]
    }
    const lines = ['Choose a definition:']
    for (let i = 0; i < locs.length; i++) {
      lines.push(
        i +
          1 +
          '. ' +
          locFile(locs[i]) +
          ':' +
          locLine(locs[i]) +
          ' (Marker ' +
          locPart(locs[i]) +
          ')',
      )
    }
    const answer = window.prompt(lines.join('\n'), '1')
    if (!answer) {
      return undefined
    }
    const n = parseInt(answer, 10)
    if (!(n >= 1 && n <= locs.length)) {
      return undefined
    }
    return locs[n - 1]
  }

  document.addEventListener('mouseover', function (e) {
    const span = e.target.closest ? e.target.closest('.def-ref') : undefined
    if (span) {
      showTooltip(span)
    } else {
      hideTooltip()
    }
  })

  document.addEventListener('click', function (e) {
    const span = e.target.closest ? e.target.closest('.def-ref') : undefined
    if (!span) {
      return
    }

    const locs = locsFromSpan(span)
    if (locs.length === 0) {
      return
    }
    const loc = locs.length === 1 ? locs[0] : pickLocation(locs)
    if (!loc) {
      return
    }
    navigateTo(loc)
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(processCodeElements, 100)
    })
  } else {
    setTimeout(processCodeElements, 100)
  }
})()
