/* JSDoc tag wrapping — first half of the annotation-md cleanup.
 *
 * Takes the markdown rendered into .annotation-md and:
 *   1. Unwraps spurious mailto: links (marked's auto-linker
 *      mistakes `name@1.2.3` for an email).
 *   2. Runs hljs over fenced @example blocks (language-javascript
 *      default when none is set).
 *   3. Walks text nodes to wrap `@tag` tokens in
 *      <span class="mdr-jsdoc-tag">, plus their optional
 *      `{Type}` annotation as <code class="mdr-jsdoc-type-inline">.
 *
 * Exposes ns.wrapJsdocTags(container) so the group pass
 * (jsdoc-group.js) can call it. Kept separate so each file
 * handles one concern. */
'use strict'
;(() => {
  const ns = window[Symbol.for('meander:pages')]
  if (!ns) {
    return
  }

  const JSDOC_TAGS = new Set([
    'augments',
    'callback',
    'default',
    'deprecated',
    'description',
    'example',
    'extends',
    'fileoverview',
    'inheritdoc',
    'internal',
    'memberof',
    'module',
    'namespace',
    'override',
    'param',
    'private',
    'prop',
    'property',
    'protected',
    'public',
    'readonly',
    'return',
    'returns',
    'see',
    'since',
    'static',
    'template',
    'this',
    'throw',
    'throws',
    'type',
    'typedef',
  ])

  const unwrapMailto = container => {
    for (const a of container.querySelectorAll('a[href^="mailto:"]')) {
      a.replaceWith(document.createTextNode(a.textContent ?? ''))
    }
  }

  const highlightCode = container => {
    if (!window.hljs) {
      return
    }
    for (const code of container.querySelectorAll('pre > code')) {
      if (code.classList.contains('hljs')) {
        continue
      }
      const hasLang = [...code.classList].some(c => c.startsWith('language-'))
      if (!hasLang) {
        /* Default @example fences without an explicit language to
         * JavaScript. Auto-detect is unreliable for short
         * snippets; JSDoc @example is always JS/TS. */
        code.classList.add('language-javascript')
      }
      window.hljs.highlightElement(code)
    }
  }

  const wrapTagTokens = container => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const textNodes = []
    let n = walker.nextNode()
    while (n) {
      /* Skip text inside nodes we've already processed (the tag
       * span itself) or inside code/pre (a `@foo` in user code
       * is not a JSDoc tag). */
      const parent = n.parentElement
      if (parent && !parent.closest('.mdr-jsdoc-tag, code, pre')) {
        textNodes.push(n)
      }
      n = walker.nextNode()
    }
    /* Match the @tag token plus an optional trailing `{…}` type
     * annotation. Tag itself becomes a muted `.mdr-jsdoc-tag`
     * span; `{Type}` becomes a separate inline <code>. Any
     * whitespace between is preserved as a text node. */
    const tagPattern = /@([A-Za-z]+)\b(\s*)(\{[^}]*\})?/g
    for (const node of textNodes) {
      const text = node.nodeValue ?? ''
      if (!text.includes('@')) {
        continue
      }
      const parts = []
      let cursor = 0
      let m
      tagPattern.lastIndex = 0
      while ((m = tagPattern.exec(text)) !== null) {
        const tag = m[1].toLowerCase()
        if (!JSDOC_TAGS.has(tag)) {
          continue
        }
        if (m.index > cursor) {
          parts.push(document.createTextNode(text.slice(cursor, m.index)))
        }
        /* Break before so the pill never inlines after preceding
         * prose. Skip if nothing precedes it in this fragment. */
        if (parts.length > 0 || cursor > 0) {
          parts.push(document.createElement('br'))
        }
        const tagSpan = document.createElement('span')
        tagSpan.className = 'mdr-jsdoc-tag'
        tagSpan.textContent = '@' + m[1]
        tagSpan.dataset.tag = m[1].toLowerCase()
        parts.push(tagSpan)
        if (m[3]) {
          if (m[2]) {
            parts.push(document.createTextNode(m[2]))
          }
          const typeCode = document.createElement('code')
          typeCode.className = 'mdr-jsdoc-type-inline'
          typeCode.textContent = m[3]
          parts.push(typeCode)
        }
        parts.push(document.createElement('br'))
        cursor = m.index + m[0].length
        if (text[cursor] === ' ') {
          cursor += 1
        }
      }
      if (parts.length === 0) {
        continue
      }
      if (cursor < text.length) {
        parts.push(document.createTextNode(text.slice(cursor)))
      }
      const frag = document.createDocumentFragment()
      for (const p of parts) {
        frag.appendChild(p)
      }
      node.parentNode?.replaceChild(frag, node)
    }
  }

  ns.wrapJsdocTags = container => {
    unwrapMailto(container)
    highlightCode(container)
    wrapTagTokens(container)
  }
})()
