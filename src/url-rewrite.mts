/**
 * Post-emit URL rewrites.
 *
 * `applyBasePathToHtml(html, basePath)` walks every [href]/[src]
 * attribute and adds `basePath` to root-relative URLs that
 * bypassed the build-time emitters (user-authored markdown
 * links in annotations + docs).
 *
 * Build-time helpers (`assetHref`, `partUrl`, etc.) already
 * apply basePath at emission, so this pass only catches
 * values that came from user content. Values already prefixed,
 * protocol URLs (https://, data:), and hash-only anchors are
 * left alone.
 *
 * Idempotent — running the pass twice is a no-op.
 */
import type { HTMLElement } from 'node-html-parser'
import { parse as parseHtml } from 'node-html-parser'

export function applyBasePathToHtml(html: string, basePath: string): string {
  if (!basePath) {
    return html
  }
  const root = parseHtml(html)
  let changed = false
  const prefix = (el: HTMLElement, attr: 'href' | 'src'): void => {
    const value = el.getAttribute(attr)
    if (!value || !value.startsWith('/')) {
      return
    }
    if (value.startsWith(basePath + '/') || value === basePath) {
      return
    }
    el.setAttribute(attr, `${basePath}${value}`)
    changed = true
  }
  for (const el of root.querySelectorAll('[href]')) {
    prefix(el, 'href')
  }
  for (const el of root.querySelectorAll('[src]')) {
    prefix(el, 'src')
  }
  return changed ? root.toString() : html
}
