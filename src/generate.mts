import {
  copyFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { marked, Marked, Renderer, type Tokens } from 'marked'

import {
  isEmail,
  isPurl,
  isScopedPackage,
  isUrl,
  _PURL_RE,
} from './classifiers.mts'
import {
  loadMeanderConfig,
  type DocEntry,
  type WalkthroughPart,
} from './config.mts'
import { polishProse } from './prose-polishers.mts'

/* ------------------------------------------------------------------ */
/*  Internal types                                                     */
/* ------------------------------------------------------------------ */

type Block = {
  file: string
  startLine: number
  endLine: number
  text: string
  cleanText: string
}

type Section = {
  id: string
  partId: number
  file: string
  startLine: number
  endLine: number
  annotation: string
  code: string
  languageClass: string
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const FILE_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.json': 'json',
  '.sh': 'bash',
}

/* Pinned highlight.js CDN assets. Hashes are sha384 for SRI —
 * computed once from the pinned @11.11.1 bytes; if the pin
 * bumps, recompute via:
 *   curl -sL <url> | openssl dgst -sha384 -binary | base64
 * Browsers refuse to execute/apply a file whose delivered bytes
 * don't match the integrity hash, so a CDN compromise or
 * silent version drift gets blocked before rendering.
 *
 * TypeScript grammar is loaded alongside the core bundle so
 * fenced ```typescript blocks in annotations (JSDoc @example)
 * highlight correctly — without it, hljs auto-detect often
 * mis-classes TS as JavaScript and loses generic syntax. */
const HLJS_CDN = {
  css: 'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/github-dark.min.css',
  cssSri:
    'sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH',
  js: 'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/highlight.min.js',
  jsSri:
    'sha384-RH2xi4eIQ/gjtbs9fUXM68sLSi99C7ZWBRX1vDrVv6GQXRibxXLbwO2NGZB74MbU',
  tsGrammar:
    'https://unpkg.com/@highlightjs/cdn-assets@11.11.1/languages/typescript.min.js',
  tsGrammarSri:
    'sha384-df1w1nJ43GNwmgbSCrT8YFIYyqFAm+lzj+b6ofuziX8Cfdg9QHFwbORDgAaj//wi',
} as const

const HLJS_LINK_CSS =
  `<link rel="stylesheet" href="${HLJS_CDN.css}" ` +
  `integrity="${HLJS_CDN.cssSri}" crossorigin="anonymous" />`
const HLJS_SCRIPT_JS =
  `<script src="${HLJS_CDN.js}" ` +
  `integrity="${HLJS_CDN.jsSri}" crossorigin="anonymous"></script>\n  ` +
  `<script src="${HLJS_CDN.tsGrammar}" ` +
  `integrity="${HLJS_CDN.tsGrammarSri}" crossorigin="anonymous"></script>`

/* Preconnect + preload hints for the hljs CDN. Preconnect opens
 * the TCP+TLS handshake before the parser hits the <script> tag;
 * preload tells the UA "fetch this with high priority" so the
 * core bundle and the TypeScript grammar download in parallel
 * with the stylesheet rather than after it. SRI must match the
 * eventual <script>/<link> use, so the hashes are repeated. */
const HLJS_PRELOAD_HINTS = [
  `<link rel="preconnect" href="https://unpkg.com" crossorigin="anonymous" />`,
  `<link rel="preload" as="style" href="${HLJS_CDN.css}" ` +
    `integrity="${HLJS_CDN.cssSri}" crossorigin="anonymous" />`,
  `<link rel="preload" as="script" href="${HLJS_CDN.js}" ` +
    `integrity="${HLJS_CDN.jsSri}" crossorigin="anonymous" />`,
  `<link rel="preload" as="script" href="${HLJS_CDN.tsGrammar}" ` +
    `integrity="${HLJS_CDN.tsGrammarSri}" crossorigin="anonymous" />`,
].join('\n  ')

function getAssetsDir(): string {
  const thisFile = fileURLToPath(import.meta.url)
  // In dist/generate.js → assets is at ../assets
  return path.join(path.dirname(thisFile), '..', 'assets')
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1
    }
  }
  return line
}

function cleanCommentText(raw: string): string {
  const withoutDelimiters = raw.replace(/^\/\*/, '').replace(/\*\/$/, '')
  const lines = withoutDelimiters
    .split('\n')
    .map(line => line.replace(/^\s*\*\s?/, ''))
  const filtered = lines.filter(
    (line, i, arr) =>
      !(line.trim().length === 0 && (i === 0 || i === arr.length - 1)),
  )
  return filtered.join('\n').trim()
}

function parseWalkthroughBlocks(file: string, source: string): Block[] {
  const blocks: Block[] = []
  const pattern = /\/\*[\s\S]*?\*\//g
  let match: RegExpExecArray | null = pattern.exec(source)
  while (match) {
    const full = match[0]
    const startIndex = match.index
    const endIndex = startIndex + full.length
    const startLine = lineNumberAt(source, startIndex)
    const endLine = lineNumberAt(source, endIndex)
    blocks.push({
      file,
      startLine,
      endLine,
      text: full,
      cleanText: cleanCommentText(full),
    })
    match = pattern.exec(source)
  }
  return blocks
}

function scoreForPart(
  part: WalkthroughPart,
  file: string,
  blockText: string,
): number {
  const lower = blockText.toLowerCase()
  let score = 0
  for (const keyword of part.keywords) {
    if (lower.includes(keyword.toLowerCase())) {
      score += 2
    }
    if (file.toLowerCase().includes(keyword.toLowerCase())) {
      score += 1
    }
  }
  return score
}

function getLanguageClass(file: string): string {
  return FILE_LANG[path.extname(file)] ?? 'plaintext'
}

function stripMultilineCommentsPreserveLines(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, match => {
    const newlineCount = (match.match(/\n/g) ?? []).length
    if (newlineCount === 0) {
      return ' '
    }
    return '\n'.repeat(newlineCount)
  })
}

/* ------------------------------------------------------------------ */
/*  Annotation markdown renderer                                       */
/* ------------------------------------------------------------------ */

/* Inline <code> classifiers live in ./classifiers; these
 * helpers wrap each kind in semantic markup so consumers can
 * style them per-kind. Helpers return a full HTML string on
 * match or `null` to fall through to marked's default. The
 * codespan renderer tries them in decreasing specificity so a
 * PURL (which could also pass isUrl broadly) is caught first. */

const span = (cls: string, content: string): string =>
  `<span class="${cls}">${escapeHtml(content)}</span>`

/**
 * Emit a PURL as segmented spans. Reuses the compiled regex
 * from ./classifiers so the character-class definition lives
 * in one place. Splits path into namespace + name on the last
 * slash.
 */
function tokenizePurlString(text: string): string | null {
  const match = _PURL_RE.exec(text)
  if (!match) {
    return null
  }
  const [, scheme, type, path, version, query, fragment] = match
  const pathMatch = path!.match(/^\/(.+)\/([^/]+)$/)
  const pathHtml = pathMatch
    ? `/${span('purl-namespace', pathMatch[1]!)}/${span('purl-name', pathMatch[2]!)}`
    : `/${span('purl-name', path!.slice(1))}`
  return (
    `<code class="purl">` +
    span('purl-scheme', scheme!) +
    span('purl-type', type!) +
    pathHtml +
    (version ? span('purl-version', version) : '') +
    (query ? span('purl-query', query) : '') +
    (fragment ? span('purl-fragment', fragment) : '') +
    `</code>`
  )
}

/** Email inside a <code> — render as a clickable mailto pill. */
function tokenizeEmailString(text: string): string | null {
  if (!isEmail(text)) {
    return null
  }
  return `<code class="email"><a href="mailto:${escapeHtml(text)}">${escapeHtml(text)}</a></code>`
}

/** Scoped npm/jsr package (`@scope/name`) — two-tone chip. */
function tokenizeScopedPackageString(text: string): string | null {
  if (!isScopedPackage(text)) {
    return null
  }
  const slash = text.indexOf('/')
  const scope = text.slice(0, slash)
  const name = text.slice(slash + 1)
  return (
    `<code class="package-scoped">` +
    span('package-scope', scope) +
    `/` +
    span('package-name', name) +
    `</code>`
  )
}

/** Absolute URL — clickable external link inside a <code>. */
function tokenizeUrlString(text: string): string | null {
  if (!isUrl(text)) {
    return null
  }
  return `<code class="url"><a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a></code>`
}

/**
 * Try each tokenizer in specificity order. PURL first (most
 * specific — scheme + structured path + optional query/frag);
 * then email (unambiguous shape); then scoped package (leading
 * `@` + single `/`); then URL (any scheme + `://`). First match
 * wins; all misses return null and marked's default codespan
 * renderer handles the span. */
function tokenizeInlineCode(text: string): string | null {
  return (
    tokenizePurlString(text) ??
    tokenizeEmailString(text) ??
    tokenizeScopedPackageString(text) ??
    tokenizeUrlString(text)
  )
}

/**
 * Known JSDoc tags — only these wrap into .annotation-block cards.
 * Unknown `@foo` tokens in prose pass through untouched.
 */
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

/**
 * Splits an annotation markdown string on JSDoc tag boundaries.
 * Each returned chunk is either a tag block (`kind: 'tag'`) or
 * preamble prose (`kind: 'prose'`). A tag block runs from its
 * `@tag` line up to (but not including) the next `@tag` line or
 * end-of-input, so multi-line @example bodies stay with their tag.
 */
function splitAnnotationByTags(markdown: string): Array<
  | { kind: 'prose'; text: string }
  | {
      kind: 'tag'
      tag: string
      type: string | null
      body: string
    }
> {
  const lines = markdown.split('\n')
  const out: Array<
    | { kind: 'prose'; text: string }
    | { kind: 'tag'; tag: string; type: string | null; body: string }
  > = []
  let buffer: string[] = []
  let currentTag: { tag: string; type: string | null; body: string[] } | null =
    null
  const flushProse = () => {
    if (buffer.length > 0 && buffer.join('').trim() !== '') {
      out.push({ kind: 'prose', text: buffer.join('\n') })
    }
    buffer = []
  }
  const flushTag = () => {
    if (currentTag) {
      out.push({
        kind: 'tag',
        tag: currentTag.tag,
        type: currentTag.type,
        body: currentTag.body.join('\n').trim(),
      })
      currentTag = null
    }
  }
  for (const line of lines) {
    const match = /^@([A-Za-z]+)(?:\s+(\{[^}]*\}))?\s*(.*)$/.exec(line.trim())
    if (match && JSDOC_TAGS.has(match[1]!.toLowerCase())) {
      flushProse()
      flushTag()
      currentTag = {
        tag: match[1]!.toLowerCase(),
        type: match[2] ?? null,
        body: match[3] ? [match[3]] : [],
      }
      continue
    }
    if (currentTag) {
      currentTag.body.push(line)
    } else {
      buffer.push(line)
    }
  }
  flushProse()
  flushTag()
  return out
}

/**
 * Render one annotation as a sequence of .annotation-block cards
 * (one per JSDoc tag) + any preamble prose. Server-side so the
 * browser ships parsed HTML; the walkTokens hook strips GFM's
 * email auto-link (annotation prose is technical — `core@7.0.0`
 * should not become <a href="mailto:...">).
 *
 * Ordering rule: @fileoverview leads, then @description, then
 * every other tag in source order. Preamble prose (not attached
 * to any tag) becomes a synthetic @description block.
 */
/* Dedicated marked instance for annotation rendering. Setup
 * happens once (module-load side effect) so each render call
 * doesn't re-install hooks. */
const annotationMarked = new Marked({
  gfm: true,
  breaks: false,
  /* Unwrap mailto auto-links when the address isn't actually
   * an email — e.g. `core@7.0.0`, `name@1.2.3` get wrongly
   * classified by GFM's email tokenizer. Real emails
   * (`alice@example.com`) keep their mailto. The email
   * classifier's shape check does the distinguishing. */
  walkTokens(token: Tokens.Generic) {
    if (
      token.type === 'link' &&
      typeof token.href === 'string' &&
      token.href.startsWith('mailto:')
    ) {
      const addr = token.href.slice('mailto:'.length)
      if (!isEmail(addr)) {
        token.type = 'text'
        token.text = token.raw
      }
    }
  },
})
/* Inline <code> spans are dispatched through a shape
 * classifier (purl / email / scoped-package / url). Whichever
 * kind matches gets a semantically-classed chip; plain code
 * falls through to marked's default (returning false from the
 * renderer hook signals "use the default"). */
annotationMarked.use({
  renderer: {
    codespan(token: Tokens.Codespan): string | false {
      return tokenizeInlineCode(token.text) ?? false
    },
  },
})

function renderAnnotationMarkdown(markdown: string): string {
  const chunks = splitAnnotationByTags(markdown.trim())
  const blocks: Array<{ html: string; order: number }> = []
  let preamble: string | null = null
  let hasExplicitDescription = false

  for (const chunk of chunks) {
    if (chunk.kind === 'prose') {
      if (preamble === null) {
        preamble = chunk.text
      } else {
        preamble = `${preamble}\n\n${chunk.text}`
      }
      continue
    }
    if (chunk.tag === 'description') {
      hasExplicitDescription = true
    }
    const typeHtml = chunk.type
      ? `<code class="annotation-type">${escapeHtml(chunk.type)}</code>`
      : ''
    const bodyHtml = chunk.body
      ? polishProse(annotationMarked.parse(chunk.body) as string)
      : ''
    const order =
      chunk.tag === 'fileoverview' ? 0 : chunk.tag === 'description' ? 1 : 2
    blocks.push({
      html:
        `<div class="annotation-block" data-tag="${chunk.tag}">` +
        `<span class="annotation-tag">@${chunk.tag}</span>` +
        (typeHtml ? ` ${typeHtml}` : '') +
        `<div class="annotation-body">${bodyHtml}</div>` +
        `</div>`,
      order,
    })
  }
  /* Preamble becomes a synthetic @description when no explicit
   * one exists. Keeps the "description leads the card stack"
   * ordering while still surfacing free-floating prose. */
  if (preamble !== null && !hasExplicitDescription) {
    const bodyHtml = polishProse(annotationMarked.parse(preamble) as string)
    blocks.push({
      html:
        `<div class="annotation-block" data-tag="description">` +
        `<span class="annotation-tag">@description</span>` +
        `<div class="annotation-body">${bodyHtml}</div>` +
        `</div>`,
      order: 1,
    })
  } else if (preamble !== null) {
    /* Explicit @description exists — keep the preamble as plain
     * prose above the cards so nothing is silently dropped. */
    const bodyHtml = polishProse(annotationMarked.parse(preamble) as string)
    blocks.unshift({
      html: `<div class="annotation-prose">${bodyHtml}</div>`,
      order: -1,
    })
  }
  blocks.sort((a, b) => a.order - b.order)
  return blocks.map(b => b.html).join('')
}

/* ------------------------------------------------------------------ */
/*  Symbol table (go-to-definition)                                    */
/* ------------------------------------------------------------------ */

/**
 * Compact tuple form: [file, line, part]. Fields positional by
 * convention so the inlined JSON stays small (no repeated
 * `"file":`/`"line":`/`"part":` keys across every entry). Order
 * mirrors how a debugger prints a location — file, then line,
 * then part (analogous to column in a stack frame).
 */
type SymbolLocation = readonly [file: string, line: number, part: number]

/**
 * Symbol table: exported-name → array of source locations.
 *
 * Shape is always an array so consumers see one path regardless
 * of whether a name is defined once (length 1) or in multiple
 * places (length > 1, e.g. a `parse` function exported from
 * several ecosystem-specific files, or TypeScript overload
 * signatures on consecutive lines). The consumer
 * (assets/sref.js) picks a single target for the trivial case
 * and shows a disambiguator for the multi-target case — rather
 * than silently dropping ambiguous names like the old
 * singleton shape did.
 *
 * Published to the page as
 * `window[Symbol.for("meander:syms")]` so it doesn't pollute
 * the plain-property namespace.
 */
type SymbolTable = Record<string, SymbolLocation[]>

type ExtractedSymbol = { name: string; line: number }

function extractSymbols(source: string): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = []
  const lines = source.split('\n')
  const pattern =
    /^export\s+(?:async\s+)?(?:type|interface|class|function|const|enum)\s+([A-Za-z][A-Za-z0-9_]*)/
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]!.trim())
    if (match?.[1]) {
      out.push({ name: match[1], line: i + 1 })
    }
  }
  return out
}

function buildSymbols(
  parts: readonly WalkthroughPart[],
  sources: Map<string, string>,
): SymbolTable {
  const byName = new Map<string, SymbolLocation[]>()
  for (const part of parts) {
    for (const file of part.files) {
      const source = sources.get(file)
      if (!source) {
        continue
      }
      for (const sym of extractSymbols(source)) {
        const loc: SymbolLocation = [file, sym.line, part.id]
        const existing = byName.get(sym.name)
        if (existing) {
          existing.push(loc)
        } else {
          byName.set(sym.name, [loc])
        }
      }
    }
  }

  const table: SymbolTable = {}
  for (const [name, locs] of byName) {
    /* Skip short names (`id`, `fn`, etc.) — too noisy against
     * real code. 3-char floor matches the previous filter.
     * Ambiguous names (defined in multiple files, or with
     * overload signatures on separate lines) flow through
     * unchanged — the array shape preserves every location so
     * consumers can disambiguate instead of silently losing
     * them. */
    if (name.length < 3) {
      continue
    }
    table[name] = locs
  }
  return table
}

function uniqueFiles(parts: readonly WalkthroughPart[]): string[] {
  const set = new Set<string>()
  for (const part of parts) {
    for (const file of part.files) {
      set.add(file)
    }
  }
  return [...set]
}

function loadSources(
  rootDir: string,
  files: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const file of files) {
    const fullPath = path.join(rootDir, file)
    if (!existsSync(fullPath)) {
      throw new Error(`Missing file from part plan: ${file}`)
    }
    map.set(file, readFileSync(fullPath, 'utf-8'))
  }
  return map
}

function buildSections(
  parts: readonly WalkthroughPart[],
  sourceMap: Map<string, string>,
): Section[] {
  const sections: Section[] = []

  for (const file of uniqueFiles(parts)) {
    const source = sourceMap.get(file)
    if (!source) {
      continue
    }
    const lines = source.split('\n')
    const blocks = parseWalkthroughBlocks(file, source)
    if (blocks.length === 0) {
      continue
    }

    const owners = parts.filter(part => part.files.includes(file))

    let i = 0
    while (i < blocks.length) {
      const first = blocks[i]!
      let j = i
      const annotationParts: string[] = [first.cleanText]
      const codeStart = Math.min(lines.length, first.endLine + 1)
      let codeEnd = codeStart
      let code = ''

      while (j < blocks.length) {
        const next = blocks[j + 1]
        codeEnd = next ? Math.max(codeStart, next.startLine - 1) : lines.length
        const rawCode = lines
          .slice(Math.max(0, codeStart - 1), codeEnd)
          .join('\n')
          .trimEnd()
        code = stripMultilineCommentsPreserveLines(rawCode)
          .replace(/^(?:[ \t]*\n)+/, '')
          .trimEnd()

        if (code.length > 0) {
          break
        }

        if (!next) {
          break
        }

        j += 1
        annotationParts.push(next.cleanText)
      }

      let owner = owners[0]
      if (!owner) {
        i = j + 1
        continue
      }

      const combinedAnnotation = annotationParts.join('\n\n')
      if (owners.length > 1) {
        let best = owner
        let bestScore = -1
        for (const part of owners) {
          const score = scoreForPart(part, file, combinedAnnotation)
          if (score > bestScore) {
            bestScore = score
            best = part
          }
        }
        owner = best
      }

      sections.push({
        id: `${owner.id}-${file}-${first.startLine}`.replaceAll(/[/.]/g, '-'),
        partId: owner.id,
        file,
        startLine: codeStart,
        endLine: codeEnd,
        annotation: combinedAnnotation,
        code,
        languageClass: getLanguageClass(file),
      })

      i = j + 1
    }
  }

  return sections.sort((a, b) => {
    if (a.partId !== b.partId) {
      return a.partId - b.partId
    }
    const aIndex = parts[a.partId - 1]?.files.indexOf(a.file) ?? -1
    const bIndex = parts[b.partId - 1]?.files.indexOf(b.file) ?? -1
    if (aIndex !== bIndex) {
      return aIndex - bIndex
    }
    return a.startLine - b.startLine
  })
}

function renderPartNav(
  slug: string,
  parts: readonly WalkthroughPart[],
  activePartId: number,
  hasDocuments: boolean,
  basePath: string,
): string {
  /* Three-zone pill strip: label, part pills (with compact
   * one-word titles via firstSignificantWord), then docs pill
   * (when present). Label + docs are styled separately so the
   * eye reads "Topics: A B C | Docs" as one nav block. */
  const label = `<span class="mdr-parts-label">Topics:</span>`
  const partLinks = parts
    .map(part => {
      const cls = part.id === activePartId ? 'active' : ''
      const shortTitle = firstSignificantWord(part.title)
      const full = part.title
      return `<a class="${cls}" href="${partUrl(slug, part, basePath)}" title="${escapeHtml(full)}">${escapeHtml(shortTitle)}</a>`
    })
    .join('\n')
  const docsLink = hasDocuments
    ? `<a class="mdr-topic-doc ${activePartId === 0 ? 'active' : ''}" href="${basePath}/${slug}/documents" title="Documents">Docs</a>`
    : ''
  return `${label}${partLinks}${docsLink}`
}

function renderPartHtml(
  slug: string,
  parts: readonly WalkthroughPart[],
  part: WalkthroughPart,
  sections: readonly Section[],
  inlineJs: string,
  symbols: SymbolTable,
  hasDocuments: boolean,
  basePath: string,
  cssHref: string,
  headExtra: string,
  footerHtml: string,
  commentBackendAttr: string,
): string {
  const sectionsByFile = new Map<string, Section[]>()
  for (const section of sections) {
    const existing = sectionsByFile.get(section.file)
    if (existing) {
      existing.push(section)
    } else {
      sectionsByFile.set(section.file, [section])
    }
  }

  const orderedFiles = part.files.filter(file => sectionsByFile.has(file))

  /* Stable anchor ID per file — for jump-to-file menu links and
   * IntersectionObserver-driven "current file" highlighting. */
  const fileAnchor = (file: string): string =>
    `file-${file.replaceAll(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
  const fileEntries = orderedFiles.map(file => ({
    path: file,
    anchor: fileAnchor(file),
  }))

  const fileBlocks = orderedFiles
    .map(file => {
      const fileSections = sectionsByFile.get(file) ?? []
      const thisAnchor = fileAnchor(file)

      /* Section row labels used by both the file-head sections
       * menu AND every per-chunk chip that clones from it. The
       * section's id is the anchor target (matches what each
       * .code-section emits as its DOM id). */
      const sectionRows = fileSections
        .map((section, i) => {
          const label = `Section ${i + 1}`
          const meta =
            section.endLine > section.startLine
              ? `Lines ${section.startLine}–${section.endLine}`
              : `Line ${section.startLine}`
          return `        <a href="#${section.id}"><span class="mdr-section-label">${label}</span><span class="mdr-section-meta">${meta}</span></a>`
        })
        .join('\n')

      const pairedRows = fileSections
        .map((section, i) => {
          const codeLines = section.code.split('\n')
          const tableRows = codeLines
            .map((line, j) => {
              const lineNum = section.startLine + j
              return `<tr><td class="line-num">${lineNum}</td><td class="line-code"><code class="language-${section.languageClass}">${escapeHtml(line)}</code></td></tr>`
            })
            .join('\n')

          const annotationHtml = renderAnnotationMarkdown(section.annotation)
          /* Per-chunk chip — a compact sections dropdown at the
           * top of each .code-section. Panel starts empty; the
           * first open clones the file-head menu's panel in
           * nav-menus.js and marks this chunk's anchor active.
           * Empty panel on disk saves repeat markup when a file
           * has many sections. Suppressed on single-section
           * files — nothing to navigate to. */
          const chip =
            fileSections.length > 1
              ? `  <details class="mdr-sections-menu mdr-section-chip" data-sections-for="${thisAnchor}" data-active-id="${section.id}">
    <summary class="count">Section ${i + 1} of ${fileSections.length}</summary>
    <div class="mdr-sections-panel"></div>
  </details>
`
              : ''
          return `<article class="annotation-card" id="ann-${section.id}">
  <div class="annotation-md">${annotationHtml}</div>
</article>
<section class="code-section" id="${section.id}">
${chip}  <pre><table class="code-table" data-file="${escapeHtml(section.file)}">${tableRows}</table></pre>
</section>`
        })
        .join('\n')

      /* Only render the jump-to-file menu when there are at least
       * two files — a dropdown with one row is noise. */
      const pathCell =
        fileEntries.length > 1
          ? `<details class="mdr-files-menu">
      <summary class="path">${escapeHtml(file)}</summary>
      <div class="mdr-files-panel">
${fileEntries
  .map(f => {
    const active = f.anchor === thisAnchor ? ' class="active"' : ''
    return `        <a href="#${f.anchor}"${active}>${escapeHtml(f.path)}</a>`
  })
  .join('\n')}
      </div>
    </details>`
          : `<span class="path">${escapeHtml(file)}</span>`

      /* Same rule: ≥2 sections → dropdown, single section →
       * plain count text (no useless menu). */
      const countCell =
        fileSections.length > 1
          ? `<details class="mdr-sections-menu">
      <summary class="count">${fileSections.length} sections</summary>
      <div class="mdr-sections-panel">
${sectionRows}
      </div>
    </details>`
          : `<span class="count">1 section</span>`

      return `<section class="file-block" id="${thisAnchor}">
  <header class="file-head">
    ${pathCell}
    ${countCell}
  </header>
  <div class="pair-grid file-grid">
    ${pairedRows || '<div class="empty">No walkthrough prose found for this file.</div><div class="empty">No source ranges found for this file.</div>'}
  </div>
</section>`
    })
    .join('\n')

  /* hotlinks.js reads this to resolve `./foo.js` quoted paths
   * inside code back to a .file-block anchor on this page.
   * Tuple form keeps the JSON small when a part has many
   * files. */
  const fileAnchorData = JSON.stringify(
    fileEntries.map(f => [f.path, f.anchor]),
  )

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(part.title)}</title>
  ${HLJS_PRELOAD_HINTS}
  ${headExtra}
  ${cssHref ? `<link rel="stylesheet" href="${cssHref}" />` : ''}
  ${HLJS_LINK_CSS}
</head>
<body data-slug="${escapeHtml(slug)}" data-part="${part.id}" data-file-anchors='${escapeHtml(fileAnchorData)}'${commentBackendAttr}>
  <header class="topbar">
    <h1>${escapeHtml(part.title)}</h1>
    <p>${escapeHtml(part.objective)}</p>
    <div class="part-nav">
      ${renderPartNav(slug, parts, part.id, hasDocuments, basePath)}
    </div>
  </header>

  <main class="files-stack">
    ${fileBlocks || '<div class="empty">No walkthrough sections matched this part.</div>'}
  </main>
  ${footerHtml}

  ${HLJS_SCRIPT_JS}
  <script>
    for (const block of document.querySelectorAll('.line-code code')) {
      hljs.highlightElement(block);
    }
  </script>
  <script>window[Symbol.for("meander:syms")] = ${JSON.stringify(symbols)};</script>
  <script>${inlineJs}</script>
</body>
</html>`
}

function renderIndexHtml(
  slug: string,
  title: string,
  parts: readonly WalkthroughPart[],
  partCounts: Map<number, number>,
  hasDocuments: boolean,
  basePath: string,
  cssHref: string,
  headExtra: string,
  partLineCounts: Map<number, number>,
  sizeTiersEnabled: boolean,
  hero: { subtitle?: string; description?: string } | undefined,
  footerHtml: string,
  bodyAttrs: string,
): string {
  /* Parts render as a card grid. Each card shows number + title,
   * the part's own objective as the card description, section
   * count, and an optional size-tier badge. Plain <ul> fallback
   * goes away — the card layout collapses gracefully on mobile
   * via CSS grid auto-fit, so no separate mobile branch. */
  const partCards = parts
    .map(part => {
      const count = partCounts.get(part.id) ?? 0
      const tier = sizeTiersEnabled
        ? sizeTier(partLineCounts.get(part.id) ?? 0)
        : null
      const badge = tier
        ? `<span class="mdr-size-tier mdr-size-tier-${tier}">${tier}</span>`
        : ''
      return `<a class="mdr-toc-card" href="${partUrl(slug, part, basePath)}">
          <span class="mdr-toc-card-header">
            <span class="mdr-toc-card-num">Marker ${part.id}</span>
            ${badge}
          </span>
          <span class="mdr-toc-card-title">${escapeHtml(part.title)}</span>
          <span class="mdr-toc-card-desc">${polishProse(escapeHtml(part.objective))}</span>
          <span class="mdr-toc-card-meta">${count} section${count === 1 ? '' : 's'}</span>
        </a>`
    })
    .join('\n')

  const docsCard = hasDocuments
    ? `<a class="mdr-toc-card mdr-toc-card-docs" href="${basePath}/${slug}/documents">
          <span class="mdr-toc-card-header">
            <span class="mdr-toc-card-num">Docs</span>
          </span>
          <span class="mdr-toc-card-title">Reference documents</span>
          <span class="mdr-toc-card-desc">Companion markdown docs for this walkthrough.</span>
        </a>`
    : ''

  /* Hero is optional; consumer provides subtitle + description.
   * Inline markdown (bold, italic, code, links) is supported in
   * description via marked.parseInline. Subtitle is plain text. */
  /* Hero description runs through polishProse like every other
   * prose surface — number highlighting + parenthetical italics
   * stay consistent across pages. The description markdown is
   * inline (no headings), so anchorifyHeadings is a no-op here. */
  const heroHtml = hero
    ? `<section class="mdr-hero">
    ${hero.subtitle ? `<p class="mdr-hero-subtitle">${escapeHtml(hero.subtitle)}</p>` : ''}
    ${hero.description ? `<p class="mdr-hero-desc">${polishProse(marked.parseInline(hero.description) as string)}</p>` : ''}
  </section>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${headExtra}
  ${cssHref ? `<link rel="stylesheet" href="${cssHref}" />` : ''}
</head>
<body${bodyAttrs}>
  <header class="topbar">
    <h1>${escapeHtml(title)}</h1>
  </header>
  <main class="mdr-index">
    ${heroHtml}
    <section class="mdr-toc">
      <h2>Markers</h2>
      <div class="mdr-toc-grid">
        ${partCards}
        ${docsCard}
      </div>
    </section>
  </main>
  ${footerHtml}
</body>
</html>`
}

type RenderedDocData = {
  filePath: string
  html: string
  headings: Array<{ id: string; text: string; level: number }>
}

function renderDocumentsHtml(
  slug: string,
  parts: readonly WalkthroughPart[],
  documents: readonly NormalizedDocEntry[],
  renderedDocs: RenderedDocData[],
  inlineJs: string,
  basePath: string,
  cssHref: string,
  headExtra: string,
  footerHtml: string,
  commentBackendAttr: string,
): string {
  // Build tab bar
  const tabButtons = renderedDocs
    .map((doc, index) => {
      const fileName = doc.filePath.split('/').pop() ?? doc.filePath
      const activeClass = index === 0 ? ' active' : ''
      return `<button class="doc-tab-btn${activeClass}" data-doc-index="${index}">${escapeHtml(fileName)}</button>`
    })
    .join('\n    ')

  // Build tab panes — first pane gets the "active" class so CSS display:none
  // doesn't hide it before doc-tabs.js initialises.
  const tabPanes = renderedDocs
    .map((doc, index) => {
      const activeClass = index === 0 ? ' active' : ''
      const display = index === 0 ? '' : ' style="display:none"'
      return `<div class="doc-tab-pane${activeClass}" data-doc-index="${index}" data-doc-file="${escapeHtml(doc.filePath)}"${display}>
    <article class="doc-content">${doc.html}</article>
  </div>`
    })
    .join('\n  ')

  // Generic description for the documents section header
  const objective = 'Reference documents for this walkthrough.'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Documents - ${escapeHtml(slug)}</title>
  ${HLJS_PRELOAD_HINTS}
  ${headExtra}
  ${cssHref ? `<link rel="stylesheet" href="${cssHref}" />` : ''}
  ${HLJS_LINK_CSS}
</head>
<body data-slug="${escapeHtml(slug)}" data-part="0" data-page-type="documents"${commentBackendAttr}>
  <header class="topbar">
    <h1>Documents</h1>
    <p>${escapeHtml(objective)}</p>
    <div class="part-nav">
      ${renderPartNav(slug, parts, 0, true, basePath)}
    </div>
  </header>

  <nav class="doc-tab-bar">
    ${tabButtons}
  </nav>

  <main class="doc-container">
    ${tabPanes}
  </main>
  ${footerHtml}

  ${HLJS_SCRIPT_JS}
  <script>
    for (const block of document.querySelectorAll('.doc-content pre code')) {
      hljs.highlightElement(block);
    }
  </script>
  <script>
    window[Symbol.for("meander:toc")] = ${JSON.stringify(
      renderedDocs.map(d => ({ file: d.filePath, headings: d.headings })),
    )};
  </script>
  <script>${inlineJs}</script>
</body>
</html>`
}

/* ------------------------------------------------------------------ */
/*  Markdown document rendering                                        */
/* ------------------------------------------------------------------ */

/**
 * Converts arbitrary text to a heading ID slug — the same transformation
 * used by the heading renderer and by link anchor normalisation, so
 * cross-reference anchors always match the generated heading IDs.
 */
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

type RenderedDocument = {
  html: string
  headings: Array<{ id: string; text: string; level: number }>
  blockCount: number
}

type ResolvedDocRef = {
  docIndex: number
  anchor: string
  /** True when the link targets the same document it appears in. */
  sameDoc?: boolean
}

/**
 * Resolves a link href to another document in the walkthrough.
 * Returns null if the link is not a cross-document reference.
 */
function resolveDocRef(
  href: string,
  currentDocPath: string,
  allDocPaths: readonly string[],
): ResolvedDocRef | null {
  if (!href) {
    return null
  }

  // Check if this is a link to another markdown file
  // Supports formats like: ./other.md, other.md, ../other.md, other.md#anchor
  let targetPath = href
  let anchor = ''

  // Extract anchor if present and slugify it so it matches the generated
  // heading ID (e.g. "C++ Design" → "c-design", same as the heading renderer).
  const hashIndex = href.indexOf('#')
  if (hashIndex !== -1) {
    targetPath = href.slice(0, hashIndex)
    const rawAnchor = href.slice(hashIndex + 1)
    // Only slugify if the anchor looks like a heading text; if it's already a
    // valid slug (all lowercase word chars and hyphens) leave it as-is.
    anchor = /^[a-z0-9-]+$/.test(rawAnchor)
      ? rawAnchor
      : slugifyHeading(rawAnchor)
  }

  // Must reference a markdown file
  if (!targetPath.endsWith('.md')) {
    return null
  }

  // Resolve the target path relative to the current document's directory.
  // This handles ./, ../, and plain filenames uniformly.
  // All doc paths use forward slashes (they come from the config JSON).
  const currentDir = path.dirname(currentDocPath).replace(/\\/g, '/')
  const base = currentDir === '.' ? targetPath : `${currentDir}/${targetPath}`
  // Normalize away any ../ or ./ segments, keeping forward slashes
  const resolvedTarget = base
    .split('/')
    .reduce((acc: string[], seg) => {
      if (seg === '..') {
        acc.pop()
      } else if (seg !== '.') {
        acc.push(seg)
      }
      return acc
    }, [])
    .join('/')

  // Find the target document in allDocPaths
  for (let i = 0; i < allDocPaths.length; i++) {
    const docPath = allDocPaths[i]!
    // Normalize stored doc path: forward slashes, no leading ./
    const normalizedDocPath = docPath.replace(/\\/g, '/').replace(/^\.\//, '')
    if (normalizedDocPath === resolvedTarget) {
      // Link targets this document — treat as a same-doc anchor
      if (docPath === currentDocPath) {
        return { docIndex: i, anchor, sameDoc: true }
      }
      return { docIndex: i, anchor }
    }
  }

  return null
}

/**
 * Wraps block-level elements in .doc-block containers with sequential data-block-id attributes.
 */
function wrapBlocks(html: string): { wrapped: string; blockCount: number } {
  const BLOCK_TAGS = /^<(h[1-6]|p|ul|ol|blockquote|pre|table|hr|details)[\s>]/i

  const lines = html.split('\n')
  const result: string[] = []
  let blockId = 0
  let inBlock = false
  let depth = 0
  let currentTag = ''
  let blockLines: string[] = []

  for (const line of lines) {
    if (!inBlock) {
      // Check if this line starts a block element
      const match = line.match(BLOCK_TAGS)
      if (match) {
        inBlock = true
        currentTag = match[1]!.toLowerCase()
        depth = 1
        blockLines = [line]

        // Check if this is a self-contained block on one line.
        // For <hr> (void element) or any element whose opening line already
        // contains the matching close tag, count open/close tag occurrences
        // using regex — more robust than a plain string search which could
        // match closing tags inside attribute values or text content.
        const openPat = new RegExp(`<${currentTag}[\\s>]`, 'gi')
        const closePat = new RegExp(`</${currentTag}>`, 'gi')
        const opensOnLine = (line.match(openPat) || []).length
        const closesOnLine = (line.match(closePat) || []).length
        if (currentTag === 'hr' || closesOnLine >= opensOnLine) {
          // Wrap the block
          result.push(
            `<div class="doc-block" data-block-id="${blockId}">`,
            `<div class="doc-block-gutter"></div>`,
            ...blockLines,
            `</div>`,
          )
          blockId += 1
          inBlock = false
          blockLines = []
          continue
        }
      } else {
        // Not a block element, pass through
        result.push(line)
      }
    } else {
      // We're inside a block, track depth
      blockLines.push(line)

      // Count opening and closing tags for the current element
      // Use regex to find all occurrences of the current tag
      const openPattern = new RegExp(`<${currentTag}[\\s>]`, 'gi')
      const closePattern = new RegExp(`</${currentTag}>`, 'gi')

      const opens = (line.match(openPattern) || []).length
      const closes = (line.match(closePattern) || []).length

      // Adjust depth: add any additional opens, subtract closes
      // Initial depth=1 already counts the opening tag that started this block
      depth += opens
      depth -= closes

      if (depth <= 0) {
        // Block is complete, wrap it
        result.push(
          `<div class="doc-block" data-block-id="${blockId}">`,
          `<div class="doc-block-gutter"></div>`,
          ...blockLines,
          `</div>`,
        )
        blockId += 1
        inBlock = false
        blockLines = []
      }
    }
  }

  // Handle any remaining unclosed block (shouldn't happen with valid HTML)
  if (inBlock && blockLines.length > 0) {
    result.push(
      `<div class="doc-block" data-block-id="${blockId}">`,
      `<div class="doc-block-gutter"></div>`,
      ...blockLines,
      `</div>`,
    )
    blockId += 1
  }

  return { wrapped: result.join('\n'), blockCount: blockId }
}

/**
 * Renders a markdown document to HTML with block wrappers and cross-reference support.
 *
 * @param filePath - Absolute path to the markdown file
 * @param docIndex - Index of this document in the allDocPaths array
 * @param allDocPaths - Array of all document paths in the walkthrough
 * @returns Rendered document with HTML, headings, and block count
 */
async function renderMarkdownDocument(
  filePath: string,
  docIndex: number,
  allDocPaths: readonly string[],
  mermaidRenderer?: import('./render-mermaid.mts').MermaidRenderer,
  mermaidTheme: import('./render-mermaid.mts').MermaidTheme = 'default',
): Promise<RenderedDocument> {
  let markdown = readFileSync(filePath, 'utf-8')
  /* Pre-pass: swap ```mermaid fences for opaque tokens so marked
   * doesn't try to highlight them. SVGs are inlined after
   * marked.parse + polishers so we don't run the HTML transforms
   * over every diagram's <text>/<path>. */
  let mermaidSvgs: Map<string, string> | null = null
  if (mermaidRenderer) {
    const { preRenderMermaidBlocks } = await import('./render-mermaid.mts')
    const pre = await preRenderMermaidBlocks(markdown, mermaidRenderer, {
      theme: mermaidTheme,
    })
    markdown = pre.markdown
    mermaidSvgs = pre.svgByToken
  }
  const headings: Array<{ id: string; text: string; level: number }> = []

  // Get the relative path for this document (for cross-reference resolution)
  const relativePath = allDocPaths[docIndex] ?? filePath

  // Create custom renderer
  const renderer = new Renderer()

  // Track seen heading slugs for deduplication
  const seenSlugs = new Map<string, number>()

  // Override heading to add IDs and collect headings for TOC.
  // In marked v17, data.text is raw markdown — use marked.parseInline() to
  // render inline formatting (bold, code, etc.) and strip tags for plain text.
  renderer.heading = function (data: { text: string; depth: number }): string {
    const { text, depth } = data
    // Render inline markdown (e.g. **bold**, `code`) to HTML
    const renderedText = marked.parseInline(text) as string
    // Strip HTML tags for the slug and TOC display text
    const plainText = renderedText.replace(/<[^>]*>/g, '')
    let slug = slugifyHeading(plainText)

    // Deduplicate: append -1, -2, ... for repeated slugs (GitHub convention).
    const count = seenSlugs.get(slug) ?? 0
    seenSlugs.set(slug, count + 1)
    if (count > 0) {
      slug = `${slug}-${count}`
    }

    // Collect heading for TOC with plain text (no HTML tags)
    headings.push({ id: slug, text: plainText, level: depth })

    // Trailing \n ensures wrapBlocks sees this as its own line, not merged
    // with the next block element
    return `<h${depth} id="${escapeHtml(slug)}">${renderedText}</h${depth}>\n`
  }

  // Override code to add language class for highlight.js.
  // Escape lang to prevent attribute injection, and add trailing \n.
  renderer.code = function (data: { text: string; lang?: string }): string {
    const { text, lang } = data
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : ''
    return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>\n`
  }

  // Override link to resolve cross-document references.
  // In marked v17, data.text is raw markdown — use marked.parseInline() to
  // render inline formatting within link text.
  renderer.link = function (data: { href: string; text: string }): string {
    const { href, text } = data
    const renderedText = marked.parseInline(text) as string

    // Same-document anchor link (e.g. #section-one) — render as plain anchor
    if (href.startsWith('#')) {
      return `<a href="${escapeHtml(href)}">${renderedText}</a>`
    }

    // Try to resolve as a cross-document reference
    const resolved = resolveDocRef(href, relativePath, allDocPaths)

    if (resolved) {
      if (resolved.sameDoc) {
        if (resolved.anchor) {
          // Same document with anchor — plain in-page link
          return `<a href="#${escapeHtml(resolved.anchor)}">${renderedText}</a>`
        }
        // Same document, no anchor — render as non-navigating inline text
        // to avoid href="#" scrolling the page to the top.
        return `<span class="doc-self-link">${renderedText}</span>`
      }
      // Cross-document link — use data attributes for client-side handling
      return `<a href="#" data-doc-ref="${resolved.docIndex}" data-doc-anchor="${escapeHtml(resolved.anchor)}">${renderedText}</a>`
    }

    // External link — open in new tab
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${renderedText}</a>`
  }

  // Parse markdown with custom renderer
  const rawHtml = marked.parse(markdown, { renderer }) as string

  /* Prose polishers (generic, idempotent):
   *   - strip "Further reading" README cross-reference lists,
   *   - tag ASCII repo-tree blocks for CSS,
   *   - add permalink anchors to h2/h3/h4,
   *   - accent-color numeric tokens,
   *   - italicize parentheticals.
   * Runs before wrapBlocks so block-wrapping logic sees the
   * transformed markup — headings carry their new ids when they
   * become anchor targets, tree blocks carry their classes. */
  let polishedHtml = polishProse(rawHtml)

  if (mermaidSvgs && mermaidSvgs.size > 0) {
    const { inlineMermaidSvgs } = await import('./render-mermaid.mts')
    polishedHtml = inlineMermaidSvgs(polishedHtml, mermaidSvgs)
  }

  // Wrap blocks
  const { wrapped, blockCount } = wrapBlocks(polishedHtml)

  return {
    html: wrapped,
    headings,
    blockCount,
  }
}

/**
 * URL path segment for a part. Uses /<slug>/parts/<filename>
 * when the part sets a filename; falls back to /<slug>/part/<id>.
 * The numeric-id form is kept for back-compat so existing
 * consumers see no change.
 */
/**
 * Build the standard footer HTML for a page. Renders meander's
 * attribution by default; consumers can override the text and
 * link or disable entirely via config.footer.
 */
function renderFooter(
  footer: boolean | { text?: string; href?: string } | undefined,
): string {
  if (footer === false) {
    return ''
  }
  const defaultText = 'Go wander with meander'
  const defaultHref = 'https://github.com/divmain/meander'
  const cfg = typeof footer === 'object' ? footer : {}
  const text = cfg.text ?? defaultText
  const href = cfg.href ?? defaultHref
  return `<footer class="mdr-footer">
    <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>
  </footer>`
}

/**
 * Normalized doc entry shape. Consumers pass strings or full
 * objects; the generator walks this shape everywhere.
 */
type NormalizedDocEntry = {
  source: string
  filename: string | undefined
  title: string | undefined
  summary: string | undefined
}

function normalizeDocs(
  docs: readonly DocEntry[] | undefined,
): NormalizedDocEntry[] {
  if (!docs) {
    return []
  }
  return docs.map((d): NormalizedDocEntry => {
    if (typeof d === 'string') {
      return {
        source: d,
        filename: undefined,
        title: undefined,
        summary: undefined,
      }
    }
    return {
      source: d.source,
      filename: d.filename,
      title: d.title,
      summary: d.summary,
    }
  })
}

/**
 * First "significant" word of a title — the first token that
 * isn't a stopword. Useful when rendering a compact label
 * that should still carry the title's subject:
 *   "Anatomy of a PURL"              → "Anatomy"
 *   "Building & Stringifying PURLs"  → "Building"
 *   "The Security Model"             → "Security"
 * Trailing punctuation is stripped from each token so
 * "Anatomy, of a PURL" still lands on "Anatomy".
 */
function firstSignificantWord(title: string): string {
  /* Articles, conjunctions, short prepositions, and verb-particle
   * tails (`Setting *Up*`, `Rolling *Out*`) never carry the
   * title's meaning — always skip. */
  const stop = new Set([
    '&',
    'a',
    'an',
    'and',
    'down',
    'for',
    'in',
    'of',
    'on',
    'or',
    'out',
    'over',
    'the',
    'through',
    'to',
    'up',
    'with',
  ])
  /* Gerund-style openers ("Getting Started", "Introducing X",
   * "Setting Up Y") read as connective tissue, not the topic.
   * When one of these leads AND a meaningful word follows, the
   * follower is the better label. When the gerund stands alone
   * ("Getting") it's all we've got, so we keep it. */
  const weakLead = new Set([
    'becoming',
    'building',
    'creating',
    'designing',
    'exploring',
    'getting',
    'introducing',
    'making',
    'setting',
    'starting',
    'understanding',
    'using',
    'working',
  ])
  const cleanWord = (w: string) => w.replace(/[,:;.!?]+$/, '')
  const words = title.split(/\s+/)
  const significant: string[] = []
  for (const w of words) {
    const cleaned = cleanWord(w)
    if (cleaned && !stop.has(cleaned.toLowerCase())) {
      significant.push(cleaned)
    }
  }
  if (significant.length === 0) {
    return words[0] ?? title
  }
  const first = significant[0]!
  if (weakLead.has(first.toLowerCase()) && significant.length > 1) {
    return significant[1]!
  }
  return first
}

/**
 * Classify a line count into a t-shirt size. Tiers are skewed
 * low to make very-small parts stand out — most tour parts
 * land in "medium" or "small", "x-large" is reserved for the
 * rare sweeping part.
 */
function sizeTier(
  lines: number,
): 'x-small' | 'small' | 'medium' | 'large' | 'x-large' {
  if (lines <= 100) {
    return 'x-small'
  }
  if (lines <= 400) {
    return 'small'
  }
  if (lines <= 1000) {
    return 'medium'
  }
  if (lines <= 2500) {
    return 'large'
  }
  return 'x-large'
}

function partUrl(
  slug: string,
  part: { id: number; filename?: string },
  basePath: string,
): string {
  const suffix = part.filename
    ? `${slug}/parts/${part.filename}`
    : `${slug}/part/${part.id}`
  return `${basePath}/${suffix}`
}

/**
 * Output filename (without path) for a part. Parts-with-
 * filename land at `parts/<filename>.html`; bare parts land
 * at `part-<id>.html`. Returned relative to outDir.
 */
function partOutputFilename(part: { id: number; filename?: string }): string {
  return part.filename ? `parts/${part.filename}.html` : `part-${part.id}.html`
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

export type GenerateOptions = {
  /**
   * URL path prefix. When the site is hosted under a subpath
   * (e.g. GitHub Pages at `/my-repo/`), every emitted `href` /
   * `src` to a same-site asset is rewritten from `/meander.css`
   * to `{basePath}/meander.css`. It's a path, not a URL —
   * matches Next.js `basePath` semantics, not Vite's `base`
   * (which allows full URLs).
   * Default: "" (site hosted at origin root).
   */
  basePath?: string | undefined
  /**
   * Subdirectory under the output dir where emitted static
   * assets (currently `meander.css`) land. Default: ""
   * (emit flat). Example: `--asset-dir assets` writes
   * `assets/meander.css` and rewrites the <link href>.
   */
  assetDir?: string | undefined
}

/**
 * Normalise a user-supplied base path so it starts with `/` and
 * has no trailing slash. Empty input → empty string (no prefixing).
 */
function normaliseBasePath(basePath: string | undefined): string {
  if (!basePath) {
    return ''
  }
  let out = basePath.trim()
  if (out === '' || out === '/') {
    return ''
  }
  if (!out.startsWith('/')) {
    out = '/' + out
  }
  return out.replace(/\/$/, '')
}

/**
 * Normalise a user-supplied asset dir — drop any leading/trailing
 * slashes so we can join it cleanly, and collapse empty values.
 */
function normaliseAssetDir(assetDir: string | undefined): string {
  if (!assetDir) {
    return ''
  }
  return assetDir.trim().replace(/^\/+|\/+$/g, '')
}

export async function generate(
  configPath: string,
  options: GenerateOptions = { __proto__: null } as GenerateOptions,
): Promise<void> {
  const { config, resolved } = loadMeanderConfig(configPath)
  const { slug, title, parts } = config
  /* Normalize doc entries: the schema accepts string shorthand
   * ("path/to/file.md") and full objects ({ source, filename?,
   * title?, summary? }). Everything downstream works against the
   * normalized shape. Call sites that just need the source path
   * can read `.source`. */
  const documents = normalizeDocs(config.documents)
  const basePath = normaliseBasePath(options.basePath)
  const assetDir = normaliseAssetDir(options.assetDir)
  /* URL prefix for asset <href>/<src>: `{basePath}/{assetDir}/`.
   * Both parts are optional. Empty → assets at site root, flat. */
  const assetHref = (filename: string): string => {
    const segments = [basePath, assetDir, filename]
      .map(p => p.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
    return '/' + segments.join('/')
  }

  /* Resolve paths against the directory containing
   * .meander.config.json, not the caller's cwd. Lets `meander
   * generate /any/path/.meander.config.json` work from any cwd. */
  const rootDir = path.resolve(configPath, '..')

  // Validate documents if present
  if (documents.length > 0) {
    const seen = new Set<string>()
    for (const d of documents) {
      if (seen.has(d.source)) {
        throw new Error(`Duplicate document path: ${d.source}`)
      }
      seen.add(d.source)
      if (!d.source.endsWith('.md')) {
        throw new Error(`Document path must end with .md: ${d.source}`)
      }
      const fullPath = path.join(rootDir, d.source)
      if (!existsSync(fullPath)) {
        throw new Error(`Document file not found: ${d.source}`)
      }
    }
    console.log(`Documents: ${documents.length} files`)
  }
  /* Config-driven emit dir. Defaults to "pages" when the
   * .meander.config.json doesn't set outDir. The resolved value
   * is used locally here and is the source of truth for the
   * Val Town blob prefix on publish — deploy-val injects it as
   * MEANDER_OUT_DIR on the val so the serving side agrees. */
  const outDirName = resolved.outDir
  const outDir = path.join(rootDir, outDirName)
  mkdirSync(outDir, { recursive: true })

  const files = uniqueFiles(parts)
  const sources = loadSources(rootDir, files)
  const sections = buildSections(parts, sources)
  const symbols = buildSymbols(parts, sources)

  const bundledAssetsDir = getAssetsDir()
  /* Non-comment scripts — always inlined (line-select is nav-ish
   * UX, sref is the symbol-reference link feature, doc-tabs/doc-toc
   * power the documents page layout). */
  const lineSelectJs = readFileSync(
    path.join(bundledAssetsDir, 'line-select.js'),
    'utf-8',
  )
  const srefJs = readFileSync(path.join(bundledAssetsDir, 'sref.js'), 'utf-8')
  const docTabsJs = readFileSync(
    path.join(bundledAssetsDir, 'doc-tabs.js'),
    'utf-8',
  )
  const blockSelectJs = readFileSync(
    path.join(bundledAssetsDir, 'block-select.js'),
    'utf-8',
  )
  const docTocJs = readFileSync(
    path.join(bundledAssetsDir, 'doc-toc.js'),
    'utf-8',
  )
  /* Head-injected scripts. boot.js sets up the shared namespace;
   * theme.js resolves the stored theme pref and writes
   * <html data-theme> synchronously, before first paint, so the
   * page never flashes light on a dark-preferring system.
   * theme.js only loads when theme is enabled — when the
   * consumer pinned to a single palette, we skip the toggle JS
   * entirely rather than ship dead code. */
  const bootJs = readFileSync(path.join(bundledAssetsDir, 'boot.js'), 'utf-8')
  const themeJs = resolved.theme.enabled
    ? readFileSync(path.join(bundledAssetsDir, 'theme.js'), 'utf-8')
    : ''
  const splitterJs = readFileSync(
    path.join(bundledAssetsDir, 'splitter.js'),
    'utf-8',
  )
  const navMenusJs = readFileSync(
    path.join(bundledAssetsDir, 'nav-menus.js'),
    'utf-8',
  )
  const hotlinksJs = readFileSync(
    path.join(bundledAssetsDir, 'hotlinks.js'),
    'utf-8',
  )
  const jsdocWrapJs = readFileSync(
    path.join(bundledAssetsDir, 'jsdoc-wrap.js'),
    'utf-8',
  )
  const jsdocGroupJs = readFileSync(
    path.join(bundledAssetsDir, 'jsdoc-group.js'),
    'utf-8',
  )
  const annotationReadyJs = readFileSync(
    path.join(bundledAssetsDir, 'annotation-ready.js'),
    'utf-8',
  )
  const inlineTokenizersJs = readFileSync(
    path.join(bundledAssetsDir, 'inline-tokenizers.js'),
    'utf-8',
  )
  const jsdocJs = [
    jsdocWrapJs,
    jsdocGroupJs,
    annotationReadyJs,
    inlineTokenizersJs,
  ].join('\n')

  /* Service worker — emit sw.js with the consumer's version
   * token replacing __MEANDER_CACHE_VERSION__, plus an inline
   * registration script gated on non-localhost (dev servers
   * shouldn't cache between reloads). */
  const swEnabled = !!config.serviceWorker
  const swOpts =
    typeof config.serviceWorker === 'object' ? config.serviceWorker : undefined
  const swVersion =
    swOpts?.version ?? new Date().toISOString().slice(0, 10).replaceAll('-', '')
  let swRegisterJs = ''
  if (swEnabled) {
    const swSrc = readFileSync(path.join(bundledAssetsDir, 'sw.js'), 'utf-8')
    let swOut = swSrc.replaceAll('__MEANDER_CACHE_VERSION__', swVersion)
    /* Minify the SW when the consumer opted in. Its Service-
     * Worker registration-gated bytes decide the install hash,
     * so shrinking here is strictly a bytes-over-the-wire win —
     * no correctness impact. */
    const minifyJsHere =
      !!config.minify &&
      (typeof config.minify === 'object' ? config.minify.js !== false : true)
    if (minifyJsHere) {
      const m = await import('./minify.mts')
      swOut = await m.minifyAsset(swOut, { kind: 'js' })
    }
    /* sw.js must land at origin root (or basePath root) so its
     * scope covers the whole site. */
    writeFileSync(path.join(outDir, 'sw.js'), swOut)
    swRegisterJs = `
if ("serviceWorker" in navigator && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
  navigator.serviceWorker.register(${JSON.stringify(assetHref('sw.js'))}).catch(() => {});
}`
  }

  const headJs = [bootJs, themeJs, swRegisterJs].filter(Boolean).join('\n')
  /* Comment-client bundle — only inlined when comments are
   * enabled. Consumers shipping their own system (e.g. encrypted
   * or SSO-gated) can set `comments: false` in
   * .meander.config.json to drop the default client + its
   * API-endpoint assumptions. */
  const commentsEnabled = resolved.comments.enabled
  const commentClientJs = commentsEnabled
    ? readFileSync(path.join(bundledAssetsDir, 'comment-client.js'), 'utf-8')
    : ''
  const unresolvedJs = commentsEnabled
    ? readFileSync(
        path.join(bundledAssetsDir, 'unresolved-comments.js'),
        'utf-8',
      )
    : ''
  const exportJs = commentsEnabled
    ? readFileSync(path.join(bundledAssetsDir, 'export-comments.js'), 'utf-8')
    : ''
  const inlineJs = commentsEnabled
    ? [
        splitterJs,
        navMenusJs,
        hotlinksJs,
        jsdocJs,
        lineSelectJs,
        commentClientJs,
        srefJs,
        unresolvedJs,
        exportJs,
      ].join('\n')
    : [splitterJs, navMenusJs, hotlinksJs, jsdocJs, lineSelectJs, srefJs].join(
        '\n',
      )
  const documentsInlineJs = commentsEnabled
    ? [
        blockSelectJs,
        commentClientJs,
        unresolvedJs,
        exportJs,
        docTabsJs,
        docTocJs,
      ].join('\n')
    : [blockSelectJs, docTabsJs, docTocJs].join('\n')

  console.log(`Symbol table: ${Object.keys(symbols).length} unique names`)

  const sectionsByPart = new Map<number, Section[]>()
  for (const part of parts) {
    sectionsByPart.set(part.id, [])
  }
  for (const section of sections) {
    sectionsByPart.get(section.partId)?.push(section)
  }

  const hasDocuments = !!(documents && documents.length > 0)
  const counts = new Map<number, number>()
  const lineCounts = new Map<number, number>()

  /* Copy CSS to output dir — under `assetDir` if configured,
   * else at output root. `bundledAssetsDir` (declared above) is
   * the npm-package-bundled asset *source* path; `assetDir` is
   * the user-chosen emit subdir. Must land before renders so
   * the cssHref in emitted HTML resolves correctly.
   *
   * Skipped entirely when `styles: false` (the consumer is
   * shipping their own stylesheet via headExtra or equivalent).
   * The template still has a <link> tag — gated below — so when
   * styles are off, no CSS file lands AND no link points at it. */
  const emitStyles = resolved.styles.base
  if (emitStyles) {
    let css = readFileSync(path.join(bundledAssetsDir, 'meander.css'), 'utf-8')
    const minifyCssHere =
      !!config.minify &&
      (typeof config.minify === 'object' ? config.minify.css !== false : true)
    if (minifyCssHere) {
      const m = await import('./minify.mts')
      css = await m.minifyAsset(css, { kind: 'css' })
    }
    const cssOutDir = assetDir ? path.join(outDir, assetDir) : outDir
    mkdirSync(cssOutDir, { recursive: true })
    writeFileSync(path.join(cssOutDir, 'meander.css'), css)
  }

  /* Copy favicon assets. Default: meander ships a bezel-derived
   * set (svg + ico + sized pngs + apple-touch-icon). Consumer
   * can override individual sizes via meander.config.json's
   * `favicon` key, or set `favicon: false` to skip entirely.
   * Assets land at the output-dir root so <link href="/..."> +
   * basePath rewrites work uniformly. */
  const faviconOpt = config.favicon
  const faviconEnabled = faviconOpt !== false
  type FaviconAssets = {
    svg?: string // filename in outDir
    ico?: string
    png16?: string
    png32?: string
    png48?: string
    png180?: string
  }
  const faviconAssets: FaviconAssets = {}
  if (faviconEnabled) {
    const bundledFavDir = path.join(bundledAssetsDir, 'favicon')
    const override =
      faviconOpt && typeof faviconOpt === 'object' ? faviconOpt : null
    /* For each slot, prefer the consumer's override path
     * (resolved relative to meander.config.json's dir), falling
     * back to the bundled default if the override isn't
     * provided or doesn't exist. */
    const resolveOverride = (p?: string): string | undefined => {
      if (!p) {
        return undefined
      }
      const full = path.resolve(rootDir, p)
      return existsSync(full) ? full : undefined
    }
    const slots: Array<[keyof FaviconAssets, string, string | undefined]> = [
      ['svg', 'favicon.svg', override?.svg],
      ['ico', 'favicon.ico', override?.ico],
      ['png16', 'favicon-16.png', override?.png?.['16']],
      ['png32', 'favicon-32.png', override?.png?.['32']],
      ['png48', 'favicon-48.png', override?.png?.['48']],
      ['png180', 'apple-touch-icon.png', override?.png?.['180']],
    ]
    for (const [slot, outName, overridePath] of slots) {
      const src =
        resolveOverride(overridePath) ?? path.join(bundledFavDir, outName)
      if (!existsSync(src)) {
        continue
      }
      copyFileSync(src, path.join(outDir, outName))
      faviconAssets[slot] = outName
    }
  }

  /* Assemble the <link> + <meta> tags injected into every
   * rendered page's <head>. Uses assetHref so basePath /
   * assetDir rewrites apply. */
  const faviconTags = faviconEnabled
    ? [
        faviconAssets.svg &&
          `<link rel="icon" type="image/svg+xml" href="${assetHref(faviconAssets.svg)}" />`,
        faviconAssets.ico &&
          `<link rel="icon" type="image/x-icon" href="${assetHref(faviconAssets.ico)}" />`,
        faviconAssets.png16 &&
          `<link rel="icon" type="image/png" sizes="16x16" href="${assetHref(faviconAssets.png16)}" />`,
        faviconAssets.png32 &&
          `<link rel="icon" type="image/png" sizes="32x32" href="${assetHref(faviconAssets.png32)}" />`,
        faviconAssets.png180 &&
          `<link rel="apple-touch-icon" href="${assetHref(faviconAssets.png180)}" />`,
      ]
        .filter(Boolean)
        .join('\n  ')
    : ''

  /* theme-color meta — either a single color or per-scheme
   * light/dark variants. Emitted as zero, one, or two meta tags.
   * Consumers that didn't opt in get no theme-color (browsers
   * use their default). */
  const themeColor =
    faviconOpt && typeof faviconOpt === 'object'
      ? faviconOpt.themeColor
      : undefined
  const themeColorTags = (() => {
    if (!themeColor) {
      return ''
    }
    if (typeof themeColor === 'string') {
      return `<meta name="theme-color" content="${themeColor}" />`
    }
    return [
      `<meta name="theme-color" content="${themeColor.light}" media="(prefers-color-scheme: light)" />`,
      `<meta name="theme-color" content="${themeColor.dark}" media="(prefers-color-scheme: dark)" />`,
    ].join('\n  ')
  })()

  /* headJs is injected synchronously in <head> so theme.js can
   * write <html data-theme> before first paint — no flash of
   * light theme on dark-preferring systems. */
  const headJsTag = `<script>${headJs}</script>`
  const headExtra = [faviconTags, themeColorTags, headJsTag]
    .filter(Boolean)
    .join('\n  ')
  const footerHtml = renderFooter(config.footer)

  /* When hosting the HTML off-origin (GH Pages, etc.), the
   * comment client needs the absolute Val Town URL to reach the
   * comment backend. The attribute is emitted onto every page's
   * <body>; comment-client.js reads it (if present) and
   * prefixes its fetch URLs. Omit when same-origin hosting
   * (Val Town itself) is in play — comments route to
   * /<slug>/api/comments alongside the HTML. */
  /* Body-level attributes emitted on every page. commentBackend
   * steers the comment client at an off-origin val; demoMode
   * toggles the read-only banner + composer disable in the
   * client. Both appear on part pages, documents pages, AND the
   * index so the banner shows up everywhere the reader lands. */
  /* Map of part-id → title, surfaced to client-side modules
   * (unresolved-comments group headers, etc.) so they can render
   * the title alongside the number without an extra fetch. Keyed
   * by id (not array index) so out-of-order or sparsely-numbered
   * parts still resolve. */
  const partTitlesById = JSON.stringify(
    Object.fromEntries(parts.map(p => [String(p.id), p.title])),
  )
  const bodyAttrs =
    (resolved.comments.backend
      ? ` data-comment-backend="${escapeHtml(resolved.comments.backend.replace(/\/+$/, ''))}"`
      : '') +
    (resolved.demoMode ? ' data-demo-mode="true"' : '') +
    ` data-part-titles='${escapeHtml(partTitlesById)}'`
  const commentBackendAttr = bodyAttrs

  /* Post-render pipeline. Order matters:
   *   1. minify — shrinks inline <script>/<svg>. Must run first
   *      because CSP hashes inline-script bodies; hashing
   *      pre-minified bytes then minifying would break the
   *      hash match.
   *   2. CSP — reads every inline <script>/<style> body (now
   *      post-minify) and injects a <meta> tag with sha256
   *      hashes.
   *   3. SRI — attribute-only; adds integrity= to <script src>
   *      and <link>. Doesn't touch inline content. */
  const minifyCfg = config.minify
  const minifyEnabled = !!minifyCfg
  const minifyOpts = typeof minifyCfg === 'object' ? minifyCfg : undefined
  const minifyJs = minifyOpts?.js ?? minifyEnabled
  const minifySvg = minifyOpts?.svg ?? minifyEnabled
  const minifyCssEnabled = minifyOpts?.css ?? minifyEnabled
  const cspEnabled = !!config.csp
  const sriEnabled = !!config.sri
  const cspOpts = typeof config.csp === 'object' ? config.csp : undefined
  const sriOpts = typeof config.sri === 'object' ? config.sri : undefined
  let securityMod: typeof import('./security.mts') | null = null
  if (cspEnabled || sriEnabled) {
    securityMod = await import('./security.mts')
  }
  let minifyMod: typeof import('./minify.mts') | null = null
  if (minifyEnabled) {
    minifyMod = await import('./minify.mts')
  }
  /* Lazy-loaded URL rewriter for user-authored root-relative
   * links that bypassed the build-time assetHref/partUrl
   * helpers. Only imported when basePath is non-empty. */
  let urlRewriteMod: typeof import('./url-rewrite.mts') | null = null
  if (basePath) {
    urlRewriteMod = await import('./url-rewrite.mts')
  }

  const finalizeHtml = async (html: string): Promise<string> => {
    let out = html
    if (minifyMod && (minifyJs || minifySvg)) {
      out = await minifyMod.minifyEmittedHtml(out, {
        js: minifyJs,
        svg: minifySvg,
      })
    }
    if (urlRewriteMod) {
      out = urlRewriteMod.applyBasePathToHtml(out, basePath)
    }
    if (securityMod && cspEnabled) {
      out = securityMod.injectCspMeta(out, {
        connectSrc: cspOpts?.connectSrc,
        cdnHosts: cspOpts?.cdnHosts,
      })
    }
    if (securityMod && sriEnabled) {
      out = await securityMod.injectSriIntegrity(out, {
        localDir: outDir,
        basePath,
        cacheDir: sriOpts?.cacheDir
          ? path.resolve(rootDir, sriOpts.cacheDir)
          : path.join(rootDir, 'node_modules', '.cache', 'meander', 'sri'),
      })
    }
    return out
  }

  for (const part of parts) {
    const partSections = sectionsByPart.get(part.id) ?? []
    counts.set(part.id, partSections.length)
    /* Total code lines across every section in this part — the
     * signal sizeTier() consumes. Counts code lines, not
     * annotation lines, since the reading effort scales with
     * code volume more than prose. */
    let lineTotal = 0
    for (const s of partSections) {
      lineTotal += s.code.split('\n').length
    }
    lineCounts.set(part.id, lineTotal)
    const html = renderPartHtml(
      slug,
      parts,
      part,
      partSections,
      inlineJs,
      symbols,
      hasDocuments,
      basePath,
      emitStyles ? assetHref('meander.css') : '',
      headExtra,
      footerHtml,
      commentBackendAttr,
    )
    const partOut = path.join(outDir, partOutputFilename(part))
    mkdirSync(path.dirname(partOut), { recursive: true })
    writeFileSync(partOut, await finalizeHtml(html))
  }

  const indexHtml = renderIndexHtml(
    slug,
    title,
    parts,
    counts,
    hasDocuments,
    basePath,
    emitStyles ? assetHref('meander.css') : '',
    headExtra,
    lineCounts,
    !!config.sizeTiers,
    config.hero,
    footerHtml,
    bodyAttrs,
  )
  writeFileSync(path.join(outDir, 'index.html'), await finalizeHtml(indexHtml))

  if (documents && documents.length > 0) {
    /* Optional mermaid renderer. Created once per build and
     * shared across every doc's pre-pass so the Chromium boot
     * cost is paid at most once. `config.mermaid` can be `true`
     * (defaults), `false` / missing (disabled), or an object
     * with theme + cacheDir overrides. */
    type MermaidRenderer = import('./render-mermaid.mts').MermaidRenderer
    let mermaidRenderer: MermaidRenderer | null = null
    if (config.mermaid) {
      const { createMermaidRenderer } = await import('./render-mermaid.mts')
      const mOpts = typeof config.mermaid === 'object' ? config.mermaid : {}
      mermaidRenderer = await createMermaidRenderer({
        repoRoot: rootDir,
        cacheDir: mOpts.cacheDir
          ? path.resolve(rootDir, mOpts.cacheDir)
          : path.join(rootDir, 'node_modules', '.cache', 'meander', 'mermaid'),
      })
    }
    const mermaidTheme: import('./render-mermaid.mts').MermaidTheme =
      (typeof config.mermaid === 'object' ? config.mermaid.theme : undefined) ??
      'default'
    const renderedDocs: RenderedDocData[] = []
    const docPaths = documents.map(d => d.source)
    for (const [index, d] of documents.entries()) {
      const fullPath = path.join(rootDir, d.source)
      const rendered = await renderMarkdownDocument(
        fullPath,
        index,
        docPaths,
        mermaidRenderer ?? undefined,
        mermaidTheme,
      )
      renderedDocs.push({
        filePath: d.source,
        html: rendered.html,
        headings: rendered.headings,
      })
    }
    if (mermaidRenderer) {
      await mermaidRenderer.close()
    }
    const documentsHtml = renderDocumentsHtml(
      slug,
      parts,
      documents,
      renderedDocs,
      documentsInlineJs,
      basePath,
      emitStyles ? assetHref('meander.css') : '',
      headExtra,
      footerHtml,
      commentBackendAttr,
    )
    writeFileSync(
      path.join(outDir, 'documents.html'),
      await finalizeHtml(documentsHtml),
    )
    console.log(`Generated documents.html with ${documents.length} documents`)
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    slug,
    title,
    hasDocuments: hasDocuments,
    /* manifest.documents keeps the legacy string[] shape (paths
     * only) so consumers parsing the manifest aren't broken by
     * the schema expansion. Extended metadata is available via
     * the richer meander.config.json they already have. */
    documents: documents.map(d => d.source),
    parts: parts.map(part => {
      const partSections = sectionsByPart.get(part.id) ?? []
      return {
        id: part.id,
        title: part.title,
        files: part.files.length,
        sections: counts.get(part.id) ?? 0,
        output: partOutputFilename(part),
        /* Per-section metadata for consumers that want to reshape
         * the tour without reparsing emitted HTML. Additive to
         * the earlier shape — `sections: <count>` stays for
         * backwards compat; full records live under `sectionList`. */
        sectionList: partSections.map(s => ({
          id: s.id,
          file: s.file,
          startLine: s.startLine,
          endLine: s.endLine,
        })),
      }
    }),
  }
  writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(summary, null, 2) + '\n',
  )

  /* Optional llms.txt / llms-full.txt emission for LLM agents
   * following the llmstxt.org convention. llms.txt is a
   * linked index; llms-full.txt is the index + the markdown
   * source of every referenced doc concatenated so an agent
   * can ingest the whole walkthrough in one pass. */
  if (config.llmsIndex) {
    const llmsOpts =
      typeof config.llmsIndex === 'object' ? config.llmsIndex : undefined
    const siteUrl = llmsOpts?.siteUrl?.replace(/\/+$/, '') ?? ''
    const abs = (href: string): string => {
      const rel = href.startsWith('/') ? href : `/${href}`
      return siteUrl ? `${siteUrl}${rel}` : rel
    }
    const partLines = parts.map(part => {
      const url = abs(partUrl(slug, part, basePath))
      return `- [Marker ${part.id}: ${part.title}](${url}): ${part.objective}`
    })
    const docLines = documents.map(d => {
      /* Prefer the clean /slug/docs/<filename> URL when the
       * consumer set a filename; fall back to the legacy
       * #anchor form on the combined documents page. */
      const url = d.filename
        ? abs(`${basePath}/${slug}/docs/${d.filename}`)
        : abs(`${basePath}/${slug}/documents#${encodeURIComponent(d.source)}`)
      const name = d.title ?? d.source.split('/').pop() ?? d.source
      const summary = d.summary ? ` — ${d.summary}` : ''
      return `- [${name}](${url})${summary}`
    })
    const lines: string[] = [`# ${title}`, '', '## Parts', '', ...partLines]
    if (docLines.length > 0) {
      lines.push('', '## Documents', '', ...docLines)
    }
    const llmsTxt = lines.join('\n') + '\n'
    writeFileSync(path.join(outDir, 'llms.txt'), llmsTxt)

    /* llms-full.txt — the index plus every doc's raw markdown
     * body, separated by `---`. Parts only have source code
     * annotations (no standalone markdown), so they're
     * surfaced by URL reference only. */
    const fullChunks: string[] = [llmsTxt]
    for (const d of documents) {
      const fullDocPath = path.join(rootDir, d.source)
      if (!existsSync(fullDocPath)) {
        continue
      }
      const body = readFileSync(fullDocPath, 'utf-8')
      fullChunks.push('\n\n---\n\n', `# ${d.source}\n\n`, body)
    }
    writeFileSync(path.join(outDir, 'llms-full.txt'), fullChunks.join(''))
  }

  /* file-anchors.json — file-path → first-section anchor-id
   * map, for consumers wiring Cmd-click-to-source links (a
   * source file referenced from another file's prose or code
   * jumps to its walkthrough location). One file may have many
   * sections; the first one's id is the "entry point" anchor,
   * same as what downstream consumers typically pick. */
  const fileAnchors: Record<string, string> = {}
  for (const section of sections) {
    if (!(section.file in fileAnchors)) {
      fileAnchors[section.file] = section.id
    }
  }
  writeFileSync(
    path.join(outDir, 'file-anchors.json'),
    JSON.stringify(fileAnchors, null, 2) + '\n',
  )

  console.log(
    `Generated ${parts.length} part files + index + manifest in ${outDir}`,
  )
}
