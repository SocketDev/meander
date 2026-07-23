/**
 * Generic HTML prose enhancers — pure string transforms that
 * make rendered annotation + document HTML read better without
 * touching source content:
 *
 * - HighlightProseNumbers: wrap digit tokens in <span class="mdr-num">
 * - ItalicizeParentheticals: wrap `(aside)` in <em>
 * - AnchorifyHeadings: give h2/h3/h4 an id + trailing `#` permalink
 * - EnhanceRepoTrees: mark ASCII directory-tree code blocks for CSS styling (dim
 *   the drawing glyphs, skip hljs)
 * - StripFurtherReading: drop "<h2>Further reading</h2>" plus every sibling until
 *   the next h2
 *
 * All functions consume an HTML string and return an HTML string.
 * Safe to call multiple times; each is idempotent (second call is
 * a no-op on already-transformed content).
 */
import type { HTMLElement } from 'node-html-parser'
import { parse as parseHtml } from 'node-html-parser'

/**
 * Give every heading (h2-h4) in rendered doc HTML an id slug
 * \+ a trailing `<a class="mdr-heading-anchor">#</a>` so readers
 * can copy a deep-link to the section. h1 is skipped — it's the
 * page title and the URL itself already anchors it.
 *
 * Slug derivation: lowercase, strip non-letter/number/whitespace,
 * collapse whitespace to `-`. Collisions get `-2`, `-3`, …
 */
export function anchorifyHeadings(html: string): string {
  const root = parseHtml(html)
  const used = new Set<string>()
  const headings = root.querySelectorAll('h2, h3, h4')
  for (const h of headings) {
    /* Idempotency: skip if a permalink anchor was already
     * inserted (double-polishing a page shouldn't produce two
     * `#` links per heading). */
    if (h.querySelector('.mdr-heading-anchor')) {
      continue
    }
    const existingId = h.getAttribute('id')
    let slug = existingId ?? ''
    if (!slug) {
      const text = h.text.trim()
      if (!text) {
        continue
      }
      const baseSlug = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]+/gu, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
      if (!baseSlug) {
        continue
      }
      slug = baseSlug
      let n = 2
      while (used.has(slug)) {
        slug = `${baseSlug}-${n++}`
      }
      h.setAttribute('id', slug)
    }
    used.add(slug)
    h.insertAdjacentHTML(
      'beforeend',
      ` <a class="mdr-heading-anchor" href="#${slug}" aria-label="Permalink to this section">#</a>`,
    )
  }
  return root.toString()
}

/**
 * Mark ASCII repo-tree code blocks (ones that draw a directory
 * hierarchy with `├──`, `└──`, `│`) so CSS can dim the drawing
 * glyphs and lift the trailing annotation column. Adds
 * `.mdr-repo-tree` to the <pre> and `nohighlight` to the <code>
 * so hljs skips it — drawing glyphs become random tokens
 * otherwise.
 */
export function enhanceRepoTrees(html: string): string {
  const root = parseHtml(html)
  const preBlocks = root.querySelectorAll('pre')
  for (const pre of preBlocks) {
    const text = pre.text
    if (!/[├└│]/.test(text)) {
      continue
    }
    const existingClass = pre.getAttribute('class') ?? ''
    /* Idempotency: don't stack `mdr-repo-tree` if a prior pass
     * already marked this pre. */
    if (!/\bmdr-repo-tree\b/.test(existingClass)) {
      pre.setAttribute('class', `${existingClass} mdr-repo-tree`.trim())
    }
    /* node-html-parser doesn't descend into <pre> for
     * querySelectorAll (they're treated as raw-content), so
     * rewrite the inner HTML directly to add `nohighlight` on
     * the first inner <code>. Regex-based because the DOM
     * walker can't reach it. Idempotent: matches a code tag
     * that doesn't already carry nohighlight. */
    const innerHtml = pre.innerHTML
    const rewritten = innerHtml.replace(
      /<code(\s[^>]*)?>/,
      (match, attrs: string | undefined) => {
        if (attrs && /\bnohighlight\b/.test(attrs)) {
          return match
        }
        const classMatch = (attrs ?? '').match(/\sclass="([^"]*)"/)
        if (classMatch) {
          const merged = `${classMatch[1]} nohighlight`.trim()
          const updatedAttrs = (attrs ?? '').replace(
            /\sclass="[^"]*"/,
            ` class="${merged}"`,
          )
          return `<code${updatedAttrs}>`
        }
        return `<code${attrs ?? ''} class="nohighlight">`
      },
    )
    if (rewritten !== innerHtml) {
      pre.innerHTML = rewritten
    }
  }
  return root.toString()
}

/**
 * Highlight numeric tokens in prose so counts + version numbers
 * pop in accent color. Touches text inside paragraphs, list items,
 * table cells, blockquotes, and h1-h4; skips code/pre/a/kbd/samp.
 *
 * Matches: version numbers (1.2.3, 11.0.0-rc.0), percentages (95%),
 * "23+", simple counts (42), optional ≥/≤/~ prefix. Skips digits
 * inside HTML numeric entities and bold list markers like `**1.**`.
 */
export function highlightProseNumbers(html: string): string {
  const root = parseHtml(html)
  const allowed = new Set([
    'BLOCKQUOTE',
    'DD',
    'DT',
    'H1',
    'H2',
    'H3',
    'H4',
    'LI',
    'P',
    'TD',
    'TH',
  ])
  const skip = new Set(['A', 'CODE', 'KBD', 'PRE', 'SAMP'])
  const pattern =
    /(?<!&#)(?<!&#x)(?<![\w.-])([≥≤~]?\s?\d+(?:\.\d+)+(?:-[a-z]+(?:\.\d+)*)?[+%]?|[≥≤~]?\s?\d+[+%]?)(?![\w-])(?!\.\d|\.\s)/gi
  const walk = (node: HTMLElement): void => {
    if (skip.has(node.tagName)) {
      return
    }
    const tag = node.tagName
    /* Inside <strong> at the start of an <li>, the number is a
     * manually-bolded list marker ("**1.** Branch"). Don't
     * re-colorize. */
    const parent = node.parentNode as HTMLElement | null
    const isLiStartMarker =
      tag === 'STRONG' &&
      parent?.tagName === 'LI' &&
      parent.firstElementChild === node &&
      /^\d+\./.test(node.text.trim())
    if (isLiStartMarker) {
      return
    }
    const children = [...node.childNodes]
    for (let i = 0, { length } = children; i < length; i += 1) {
      const child = children[i]!
      const any = child as unknown as {
        nodeType: number
        rawText?: string | undefined
      }
      if (any.nodeType === 3) {
        if (!allowed.has(tag)) {
          continue
        }
        const text: string = any.rawText ?? ''
        if (!pattern.test(text)) {
          continue
        }
        pattern.lastIndex = 0
        any.rawText = text.replace(pattern, '<span class="mdr-num">$1</span>')
      } else if (any.nodeType === 1) {
        walk(child as HTMLElement)
      }
    }
  }
  walk(root)
  return root.toString()
}

/**
 * Wrap parenthetical asides in prose with <em> so "(extra info)"
 * reads as a quiet aside. Only touches text inside paragraphs,
 * list items, table cells, and blockquotes; leaves <code>, <pre>,
 * headings, and their descendants alone.
 *
 * Matches `(…)` with 2+ chars inside and no parens/tags/quotes,
 * so nested or complex expressions fall through untouched.
 */
export function italicizeParentheticals(html: string): string {
  const root = parseHtml(html)
  const allowed = new Set(['BLOCKQUOTE', 'DD', 'DT', 'LI', 'P', 'TD', 'TH'])
  const walk = (node: HTMLElement): void => {
    const tag = node.tagName
    if (
      tag === 'A' ||
      tag === 'CODE' ||
      tag === 'KBD' ||
      tag === 'PRE' ||
      tag === 'SAMP'
    ) {
      return
    }
    for (const child of node.childNodes) {
      const any = child as unknown as {
        nodeType: number
        rawText?: string | undefined
      }
      if (any.nodeType === 3) {
        if (!allowed.has(tag)) {
          continue
        }
        const text: string = any.rawText ?? ''
        if (!/\([^()<>"'`]{2,}\)/.test(text)) {
          continue
        }
        const rewritten = text.replace(
          /\(([^()<>"'`]{2,})\)/g,
          (_, inner) => `(<em>${inner}</em>)`,
        )
        if (rewritten !== text) {
          any.rawText = rewritten
        }
      } else if (any.nodeType === 1) {
        walk(child as HTMLElement)
      }
    }
  }
  walk(root)
  return root.toString()
}

/**
 * Run the full default stack in the canonical order. Consumers
 * who only want a subset should call the individual functions.
 */
export function polishProse(html: string): string {
  let out = html
  out = stripFurtherReading(out)
  out = enhanceRepoTrees(out)
  out = anchorifyHeadings(out)
  out = highlightProseNumbers(out)
  out = italicizeParentheticals(out)
  return out
}

/**
 * Remove any `<h2>Further reading</h2>` section from a rendered
 * doc. README-style docs often close with a cross-reference list
 * that makes sense in a git repo but becomes dead links in a
 * generated walkthrough. Case-insensitive title match, catches
 * variants like "Further Reading" and "Further reading:".
 */
export function stripFurtherReading(html: string): string {
  const root = parseHtml(html)
  const headings = root.querySelectorAll('h2')
  for (const h of headings) {
    const text = h.text
      .trim()
      .toLowerCase()
      .replace(/[:.…]+$/, '')
    if (text !== 'further reading') {
      continue
    }
    const parent = h.parentNode as HTMLElement | null
    /* v8 ignore start -- defensive; both guards cover unreachable DOM states. */
    if (!parent) {
      continue
    }
    const children = parent.childNodes
    const startIdx = children.indexOf(h)
    if (startIdx < 0) {
      continue
    }
    /* v8 ignore stop */
    const toRemove: unknown[] = []
    for (let i = startIdx; i < children.length; i++) {
      const c = children[i]
      if (i > startIdx && (c as HTMLElement).tagName === 'H2') {
        break
      }
      toRemove.push(c)
    }
    for (let i = 0, { length } = toRemove; i < length; i += 1) {
      const n = toRemove[i]!
      ;(n as { remove?: (() => void) | undefined }).remove?.()
    }
  }
  return root.toString()
}
