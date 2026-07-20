import { normalizePath } from '@socketsecurity/lib-stable/paths/normalize'

/* Cmd/Ctrl-click links inside code lines.
 *   - URLs: any http:// or https:// substring in code becomes
 *     an <a> that opens in a new tab when modifier-clicked.
 *   - Cross-file paths: quoted relative paths ("./foo.js") whose
 *     resolved path matches another .file-block on this page
 *     navigate to that block's anchor (same window).
 *
 * The <a> is invisible (no underline, inherits color) until the
 * modifier key is held — body.mdr-mod-pressed flips on and CSS
 * reveals a dotted underline + pointer. Bare clicks do nothing
 * so code selection still works.
 *
 * Must run after hljs has tokenized — hljs splits text nodes
 * when it runs, so any <a> wraps made before hljs would get
 * blown away. Uses ns.onHljsReady to gate. */
;(() => {
  const ns = window[Symbol.for('meander:pages')]
  if (!ns) {
    return
  }

  const installSourceLinks = () => {
    const rawAnchors = document.body.getAttribute('data-file-anchors')
    const anchorByPath = new Map()
    if (rawAnchors) {
      try {
        const entries = JSON.parse(rawAnchors)
        for (const [p, a] of entries) {
          anchorByPath.set(p, a)
        }
      } catch {
        /* Malformed data — skip cross-file wiring, keep URL
         * wrapping working. */
      }
    }

    /* Basename-swap fallback: a source ref like `./compare.js`
     * should resolve to `compare.ts` if the .ts version is what
     * we emitted. Keyed by `<dir>/<basename>` without extension. */
    const anchorByStem = new Map()
    for (const [p, anchor] of anchorByPath) {
      const stem = p.replace(/\.[a-z0-9]+$/i, '')
      if (!anchorByStem.has(stem)) {
        anchorByStem.set(stem, anchor)
      }
    }

    const resolveRelPath = (fromPath, ref) => {
      if (!ref.startsWith('./') && !ref.startsWith('../')) {
        return undefined
      }
      const fromDir = normalizePath(fromPath).split('/').slice(0, -1)
      const segs = ref.split('/')
      const out = [...fromDir]
      for (let i = 0, { length } = segs; i < length; i += 1) {
        const seg = segs[i]
        if (seg === '' || seg === '.') {
          continue
        }
        if (seg === '..') {
          out.pop()
        } else {
          out.push(seg)
        }
      }
      const resolved = out.join('/')
      if (anchorByPath.has(resolved)) {
        return anchorByPath.get(resolved)
      }
      const stem = resolved.replace(/\.[a-z0-9]+$/i, '')
      if (anchorByStem.has(stem)) {
        return anchorByStem.get(stem)
      }
      return undefined
    }

    const urlRe = /https?:\/\/[^\s'"`<>)]+/g
    // Opening quote (single or double) captured in group 1 for the closing
    // backreference; `\.{1,2}\/` matches `./` or `../`; `[^'"\`]+` consumes
    // the path stopping at any quote or backtick; `\1` matches the same closer.
    const quotedPathRe = /(['"])(\.{1,2}\/[^'"`]+)\1/g

    const wrapMatches = (textNode, filePath) => {
      const text = textNode.nodeValue
      if (!text) {
        return
      }
      const matches = []
      for (const m of text.matchAll(urlRe)) {
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          href: m[0],
          type: 'url',
        })
      }
      for (const m of text.matchAll(quotedPathRe)) {
        const pathRef = m[2]
        const anchor = filePath ? resolveRelPath(filePath, pathRef) : undefined
        if (!anchor) {
          continue
        }
        const innerStart = m.index + 1
        matches.push({
          start: innerStart,
          end: innerStart + pathRef.length,
          href: `#${anchor}`,
          type: 'file',
        })
      }
      if (matches.length === 0) {
        return
      }
      matches.sort((a, b) => a.start - b.start)

      const parent = textNode.parentNode
      if (!parent) {
        return
      }
      let cursor = 0
      const frag = document.createDocumentFragment()
      for (let i = 0, { length } = matches; i < length; i += 1) {
        const m = matches[i]
        if (m.start < cursor) {
          continue
        }
        if (m.start > cursor) {
          frag.appendChild(document.createTextNode(text.slice(cursor, m.start)))
        }
        const a = document.createElement('a')
        a.className = 'mdr-src-link'
        a.setAttribute('data-link-type', m.type)
        a.href = m.href
        if (m.type === 'url') {
          a.target = '_blank'
          a.rel = 'noopener noreferrer'
        }
        a.textContent = text.slice(m.start, m.end)
        frag.appendChild(a)
        cursor = m.end
      }
      if (cursor < text.length) {
        frag.appendChild(document.createTextNode(text.slice(cursor)))
      }
      parent.replaceChild(frag, textNode)
    }

    for (const table of document.querySelectorAll('.code-table')) {
      const filePath = table.getAttribute('data-file')
      for (const cell of table.querySelectorAll('.line-code')) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
        const textNodes = []
        let node = walker.nextNode()
        while (node) {
          textNodes.push(node)
          node = walker.nextNode()
        }
        for (let i = 0, { length } = textNodes; i < length; i += 1) {
          const t = textNodes[i]
          wrapMatches(t, filePath)
        }
      }
    }

    /* Modifier-key tracking — toggle body.mdr-mod-pressed while
     * Cmd (macOS) / Ctrl (others) is held. Dedupe because
     * auto-repeat keydown fires continuously. */
    let modState = false
    const setMod = pressed => {
      if (modState === pressed) {
        return
      }
      modState = pressed
      document.body.classList.toggle('mdr-mod-pressed', pressed)
    }
    const passive = { passive: true }
    addEventListener(
      'keydown',
      e => {
        if (e.key === 'Control' || e.key === 'Meta') {
          setMod(true)
        }
      },
      passive,
    )
    addEventListener(
      'keyup',
      e => {
        if (e.key === 'Control' || e.key === 'Meta') {
          setMod(false)
        }
      },
      passive,
    )
    addEventListener('blur', () => setMod(false), passive)

    /* Block plain clicks; only modifier-held clicks navigate. */
    document.addEventListener('click', e => {
      const link = e.target.closest?.('.mdr-src-link')
      if (!link) {
        return
      }
      if (!e.metaKey && !e.ctrlKey) {
        e.preventDefault()
      }
    })
  }

  ns.onHljsReady(installSourceLinks)
})()
