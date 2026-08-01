/* Trail filter — hides .mdr-trail-row entries whose visible text
 * (title + summary) and data-keywords don't include the user's
 * query. No-op when the .mdr-trail-filter input is absent (i.e.
 * trail count is below the filter threshold).
 *
 * Match is case-insensitive substring across the row's title +
 * summary text + data-keywords (which carries the part's
 * config-declared keywords as a space-joined string). The count
 * pill updates on every keystroke for live feedback. */
;(function () {
  'use strict'

  const ns = window[Symbol.for('meander:pages')]
  if (!ns) {
    return
  }

  ns.onReady(() => {
    const input = document.querySelector('.mdr-trail-filter')
    if (!input) {
      return
    }
    const list = document.querySelector('.mdr-trail-list')
    if (!list) {
      return
    }
    const countEl = document.querySelector('.mdr-trail-count')
    const rows = Array.from(list.querySelectorAll('.mdr-trail-row'))

    /* Pre-tokenise each row's haystack once so every keystroke
     * compares strings, not DOM. Keywords live on a data attr;
     * title + summary come from the rendered text content. */
    const haystacks = rows.map(row => {
      const titleEl = row.querySelector('.mdr-trail-title')
      const summaryEl = row.querySelector('.mdr-trail-summary')
      const keywords = row.getAttribute('data-keywords') || ''
      const text = [
        titleEl ? titleEl.textContent : '',
        summaryEl ? summaryEl.textContent : '',
        keywords,
      ]
        .join(' ')
        .toLowerCase()
      return text
    })

    const total = rows.length

    function applyFilter() {
      const q = input.value.trim().toLowerCase()
      let visible = 0
      for (let i = 0; i < rows.length; i++) {
        const match = q === '' || haystacks[i].includes(q)
        rows[i].hidden = !match
        if (match) {
          visible++
        }
      }
      if (countEl) {
        countEl.textContent = q === '' ? String(total) : visible + ' / ' + total
      }
    }

    input.addEventListener('input', applyFilter)
    /* Esc clears the field — common a11y pattern for type-ahead
     * filters; keeps the input focused so the user can keep
     * typing without re-clicking. */
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape' && input.value !== '') {
        input.value = ''
        applyFilter()
      }
    })
  })
})()
