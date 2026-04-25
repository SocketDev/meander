/* Column splitter — per-file prose/code pane resize handle.
 *
 * Stores the split as a --col-split CSS var (percent 20..80)
 * on :root. Pointer Events work for mouse + touch + pen.
 * Reads DOM geometry once at pointerdown; pointermove only
 * queues values into dragState and rAF coalesces writes so
 * multiple pointer frames per refresh collapse into one write. */
'use strict'
;(() => {
  const ns = window[Symbol.for('meander:pages')]
  if (!ns) {
    return
  }

  const SPLIT_KEY = 'meander:pages:col-split'
  const DEFAULT_SPLIT = 50
  const MIN = 20
  const MAX = 80
  const SMALL_STEP = 1
  const LARGE_STEP = 5
  const { storageGet, storageSet } = ns

  const clamp = n => {
    if (n < MIN) {
      return MIN
    }
    if (n > MAX) {
      return MAX
    }
    return n
  }

  const readStored = () => {
    const v = parseFloat(storageGet(SPLIT_KEY) || '')
    return isFinite(v) && v >= MIN && v <= MAX ? v : null
  }
  const persist = value => storageSet(SPLIT_KEY, String(value))

  const applySplit = value => {
    document.documentElement.style.setProperty('--col-split', String(value))
  }
  const readCurrent = () => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--col-split')
      .trim()
    const n = parseFloat(raw)
    return isFinite(n) ? n : DEFAULT_SPLIT
  }

  const storedSplit = readStored()
  if (storedSplit !== null) {
    applySplit(storedSplit)
  }

  const attachHandle = block => {
    /* Attach to the inner grid (not the outer file-block) so
     * the rail only spans the prose+code region. */
    const grid = block.querySelector('.pair-grid, .file-grid')
    if (!grid) {
      return
    }
    if (grid.querySelector('.col-splitter')) {
      return
    }

    const handle = document.createElement('div')
    handle.className = 'col-splitter'
    handle.setAttribute('role', 'separator')
    handle.setAttribute('aria-orientation', 'vertical')
    handle.setAttribute('aria-label', 'Resize prose and code columns')
    handle.setAttribute('aria-valuemin', String(MIN))
    handle.setAttribute('aria-valuemax', String(MAX))
    handle.setAttribute('aria-valuenow', String(readCurrent()))
    handle.tabIndex = 0

    const hotspot = document.createElement('div')
    hotspot.className = 'col-hotspot'
    hotspot.setAttribute('aria-hidden', 'true')
    handle.appendChild(hotspot)

    /* Hot-path state captured at pointerdown so onMove never
     * reads the DOM (getBoundingClientRect after a style write
     * forces synchronous layout). Writes go to rAF-coalesced
     * property sets. */
    let dragState = null
    let rafId = 0
    const flush = () => {
      rafId = 0
      if (!dragState) {
        return
      }
      const {
        pendingClientX,
        pendingClientY,
        gridLeft,
        gridWidth,
        handleTop,
        handleHeight,
      } = dragState
      if (pendingClientX !== null && gridWidth > 0) {
        const pct = clamp(((pendingClientX - gridLeft) / gridWidth) * 100)
        applySplit(pct)
        dragState.lastPct = pct
      }
      if (pendingClientY !== null && handleHeight > 0) {
        const y = Math.max(
          0,
          Math.min(handleHeight, pendingClientY - handleTop),
        )
        hotspot.style.transform = `translate3d(-50%, ${y}px, 0)`
      }
      dragState.pendingClientX = null
      dragState.pendingClientY = null
    }
    const scheduleFlush = () => {
      if (rafId === 0) {
        rafId = requestAnimationFrame(flush)
      }
    }

    handle.addEventListener('pointerdown', event => {
      event.preventDefault()
      handle.setPointerCapture(event.pointerId)
      const gridRect = grid.getBoundingClientRect()
      const handleRect = handle.getBoundingClientRect()
      dragState = {
        gridLeft: gridRect.left,
        gridWidth: gridRect.width,
        handleTop: handleRect.top,
        handleHeight: handleRect.height,
        pendingClientX: event.clientX,
        pendingClientY: event.clientY,
        lastPct: null,
      }
      scheduleFlush()
      handle.classList.add('dragging')
      document.body.classList.add('col-resizing')

      const onMove = moveEvent => {
        if (!dragState) {
          return
        }
        dragState.pendingClientX = moveEvent.clientX
        dragState.pendingClientY = moveEvent.clientY
        scheduleFlush()
      }

      const onEnd = () => {
        handle.releasePointerCapture(event.pointerId)
        handle.classList.remove('dragging')
        document.body.classList.remove('col-resizing')
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onEnd)
        handle.removeEventListener('pointercancel', onEnd)
        const finalPct = dragState?.lastPct ?? readCurrent()
        handle.setAttribute('aria-valuenow', String(Math.round(finalPct)))
        dragState = null
        if (rafId !== 0) {
          cancelAnimationFrame(rafId)
          rafId = 0
        }
        persist(readCurrent())
      }

      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onEnd)
      handle.addEventListener('pointercancel', onEnd)
    })

    handle.addEventListener('keydown', event => {
      const step = event.shiftKey ? LARGE_STEP : SMALL_STEP
      let next
      switch (event.key) {
        case 'ArrowLeft':
          next = readCurrent() - step
          break
        case 'ArrowRight':
          next = readCurrent() + step
          break
        case 'Home':
          next = MIN
          break
        case 'End':
          next = MAX
          break
        default:
          return
      }
      event.preventDefault()
      next = clamp(next)
      applySplit(next)
      persist(next)
      handle.setAttribute('aria-valuenow', String(Math.round(next)))
    })

    handle.addEventListener('dblclick', () => {
      applySplit(DEFAULT_SPLIT)
      persist(DEFAULT_SPLIT)
      handle.setAttribute('aria-valuenow', String(DEFAULT_SPLIT))
    })

    grid.appendChild(handle)
  }

  const installAll = () => {
    for (const block of document.querySelectorAll('.file-block')) {
      attachHandle(block)
    }
  }

  ns.onReady(installAll)
})()
