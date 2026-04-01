import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { marked, Renderer } from "marked";

/* ------------------------------------------------------------------ */
/*  TypeBox Schemas                                                    */
/* ------------------------------------------------------------------ */

const WalkthroughPartSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1 }),
  objective: Type.String({ minLength: 1 }),
  keywords: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

const WalkthroughConfigSchema = Type.Object({
  slug: Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9-]*$" }),
  title: Type.String({ minLength: 1 }),
  documents: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })
  ),
  parts: Type.Array(WalkthroughPartSchema, { minItems: 1 }),
});

type WalkthroughPart = Static<typeof WalkthroughPartSchema>;
type WalkthroughConfig = Static<typeof WalkthroughConfigSchema>;

/* ------------------------------------------------------------------ */
/*  Internal types                                                     */
/* ------------------------------------------------------------------ */

type Block = {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  cleanText: string;
};

type Section = {
  id: string;
  partId: number;
  file: string;
  startLine: number;
  endLine: number;
  annotation: string;
  code: string;
  languageClass: string;
};

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const FILE_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".json": "json",
  ".sh": "bash",
};

function getAssetsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // In dist/generate.js → assets is at ../assets
  return join(dirname(thisFile), "..", "assets");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function cleanCommentText(raw: string): string {
  const withoutDelimiters = raw.replace(/^\/\*/, "").replace(/\*\/$/, "");
  const lines = withoutDelimiters.split("\n").map((line) => line.replace(/^\s*\*\s?/, ""));
  const filtered = lines.filter((line, i, arr) => !(line.trim().length === 0 && (i === 0 || i === arr.length - 1)));
  return filtered.join("\n").trim();
}

function parseWalkthroughBlocks(file: string, source: string): Block[] {
  const blocks: Block[] = [];
  const pattern = /\/\*[\s\S]*?\*\//g;
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match) {
    const full = match[0];
    const startIndex = match.index;
    const endIndex = startIndex + full.length;
    const startLine = lineNumberAt(source, startIndex);
    const endLine = lineNumberAt(source, endIndex);
    blocks.push({
      file,
      startLine,
      endLine,
      text: full,
      cleanText: cleanCommentText(full),
    });
    match = pattern.exec(source);
  }
  return blocks;
}

function scoreForPart(part: WalkthroughPart, file: string, blockText: string): number {
  const lower = blockText.toLowerCase();
  let score = 0;
  for (const keyword of part.keywords) {
    if (lower.includes(keyword.toLowerCase())) {
      score += 2;
    }
    if (file.toLowerCase().includes(keyword.toLowerCase())) {
      score += 1;
    }
  }
  return score;
}

function getLanguageClass(file: string): string {
  return FILE_LANG[extname(file)] ?? "plaintext";
}

function stripMultilineCommentsPreserveLines(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    const newlineCount = (match.match(/\n/g) ?? []).length;
    if (newlineCount === 0) {
      return " ";
    }
    return "\n".repeat(newlineCount);
  });
}

/* ------------------------------------------------------------------ */
/*  Definition index (go-to-definition)                                */
/* ------------------------------------------------------------------ */

type Definition = {
  name: string;
  file: string;
  line: number;
  partId: number;
};

type DefinitionIndex = Record<string, { file: string; line: number; part: number }>;

function extractDefinitions(file: string, source: string): Omit<Definition, "partId">[] {
  const defs: Omit<Definition, "partId">[] = [];
  const lines = source.split("\n");

  const pattern = /^export\s+(?:async\s+)?(?:type|interface|class|function|const|enum)\s+([A-Za-z][A-Za-z0-9_]*)/;

  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]!.trim());
    if (match?.[1]) {
      defs.push({ name: match[1], file, line: i + 1 });
    }
  }
  return defs;
}

function buildDefinitionIndex(
  parts: readonly WalkthroughPart[],
  sources: Map<string, string>,
): DefinitionIndex {
  const allDefs: Definition[] = [];
  for (const part of parts) {
    for (const file of part.files) {
      const source = sources.get(file);
      if (!source) continue;
      const fileDefs = extractDefinitions(file, source);
      for (const def of fileDefs) {
        allDefs.push({ ...def, partId: part.id });
      }
    }
  }

  const byName = new Map<string, Definition[]>();
  for (const def of allDefs) {
    const existing = byName.get(def.name);
    if (existing) {
      existing.push(def);
    } else {
      byName.set(def.name, [def]);
    }
  }

  const index: DefinitionIndex = {};
  for (const [name, defs] of byName) {
    if (name.length < 3) continue;
    const uniqueFiles = new Set(defs.map((d) => d.file));
    if (uniqueFiles.size > 1) continue;
    const def = defs[0]!;
    index[name] = { file: def.file, line: def.line, part: def.partId };
  }

  return index;
}

function uniqueFiles(parts: readonly WalkthroughPart[]): string[] {
  const set = new Set<string>();
  for (const part of parts) {
    for (const file of part.files) {
      set.add(file);
    }
  }
  return [...set];
}

function loadSources(rootDir: string, files: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of files) {
    const path = join(rootDir, file);
    if (!existsSync(path)) {
      throw new Error(`Missing file from part plan: ${file}`);
    }
    map.set(file, readFileSync(path, "utf-8"));
  }
  return map;
}

function buildSections(parts: readonly WalkthroughPart[], sourceMap: Map<string, string>): Section[] {
  const sections: Section[] = [];

  for (const file of uniqueFiles(parts)) {
    const source = sourceMap.get(file);
    if (!source) {
      continue;
    }
    const lines = source.split("\n");
    const blocks = parseWalkthroughBlocks(file, source);
    if (blocks.length === 0) {
      continue;
    }

    const owners = parts.filter((part) => part.files.includes(file));

    let i = 0;
    while (i < blocks.length) {
      const first = blocks[i]!;
      let j = i;
      const annotationParts: string[] = [first.cleanText];
      const codeStart = Math.min(lines.length, first.endLine + 1);
      let codeEnd = codeStart;
      let code = "";

      while (j < blocks.length) {
        const next = blocks[j + 1];
        codeEnd = next ? Math.max(codeStart, next.startLine - 1) : lines.length;
        const rawCode = lines.slice(Math.max(0, codeStart - 1), codeEnd).join("\n").trimEnd();
        code = stripMultilineCommentsPreserveLines(rawCode)
          .replace(/^(?:[ \t]*\n)+/, "")
          .trimEnd();

        if (code.length > 0) {
          break;
        }

        if (!next) {
          break;
        }

        j += 1;
        annotationParts.push(next.cleanText);
      }

      let owner = owners[0];
      if (!owner) {
        i = j + 1;
        continue;
      }

      const combinedAnnotation = annotationParts.join("\n\n");
      if (owners.length > 1) {
        let best = owner;
        let bestScore = -1;
        for (const part of owners) {
          const score = scoreForPart(part, file, combinedAnnotation);
          if (score > bestScore) {
            bestScore = score;
            best = part;
          }
        }
        owner = best;
      }

      sections.push({
        id: `${owner.id}-${file}-${first.startLine}`.replaceAll(/[\/.]/g, "-"),
        partId: owner.id,
        file,
        startLine: codeStart,
        endLine: codeEnd,
        annotation: combinedAnnotation,
        code,
        languageClass: getLanguageClass(file),
      });

      i = j + 1;
    }
  }

  return sections.sort((a, b) => {
    if (a.partId !== b.partId) {
      return a.partId - b.partId;
    }
    const aIndex = parts[a.partId - 1]?.files.indexOf(a.file) ?? -1;
    const bIndex = parts[b.partId - 1]?.files.indexOf(b.file) ?? -1;
    if (aIndex !== bIndex) {
      return aIndex - bIndex;
    }
    return a.startLine - b.startLine;
  });
}

function renderPartNav(
  slug: string,
  parts: readonly WalkthroughPart[],
  activePartId: number,
  hasDocuments: boolean,
): string {
  const docsLink = hasDocuments
    ? `<a class="${activePartId === 0 ? "active" : ""}" href="/${slug}/documents">Documents</a>\n`
    : "";
  const partLinks = parts
    .map((part) => {
      const cls = part.id === activePartId ? "active" : "";
      return `<a class="${cls}" href="/${slug}/part/${part.id}">Part ${part.id}</a>`;
    })
    .join("\n");
  return docsLink + partLinks;
}



function renderPartHtml(slug: string, parts: readonly WalkthroughPart[], part: WalkthroughPart, sections: readonly Section[], inlineJs: string, defIndex: DefinitionIndex, hasDocuments: boolean): string {
  const sectionsByFile = new Map<string, Section[]>();
  for (const section of sections) {
    const existing = sectionsByFile.get(section.file);
    if (existing) {
      existing.push(section);
    } else {
      sectionsByFile.set(section.file, [section]);
    }
  }

  const orderedFiles = part.files.filter((file) => sectionsByFile.has(file));

  const fileBlocks = orderedFiles
    .map((file) => {
      const fileSections = sectionsByFile.get(file) ?? [];
      const pairedRows = fileSections
        .map((section) => {
          const codeLines = section.code.split("\n");
          const tableRows = codeLines
            .map((line, i) => {
              const lineNum = section.startLine + i;
              return `<tr><td class="line-num">${lineNum}</td><td class="line-code"><code class="language-${section.languageClass}">${escapeHtml(line)}</code></td></tr>`;
            })
            .join("\n");

          return `<article class="annotation-card" id="ann-${section.id}">
  <textarea class="annotation-md-source" hidden>${escapeHtml(section.annotation)}</textarea>
  <div class="annotation-md"></div>
</article>
<section class="code-section" id="${section.id}">
  <pre><table class="code-table" data-file="${escapeHtml(section.file)}">${tableRows}</table></pre>
</section>`;
        })
        .join("\n");

      return `<section class="file-block">
  <header class="file-head">
    <span class="path">${escapeHtml(file)}</span>
    <span class="count">${fileSections.length} section${fileSections.length === 1 ? "" : "s"}</span>
  </header>
  <div class="pair-grid file-grid">
    ${pairedRows || '<div class="empty">No walkthrough prose found for this file.</div><div class="empty">No source ranges found for this file.</div>'}
  </div>
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Walkthrough Part ${part.id}: ${escapeHtml(part.title)}</title>
  <link rel="stylesheet" href="/walkthrough.css" />
  <link rel="stylesheet" href="https://unpkg.com/@highlightjs/cdn-assets@11.10.0/styles/github-dark.min.css" />
</head>
<body data-slug="${escapeHtml(slug)}" data-part="${part.id}">
  <header class="topbar">
    <h1>Part ${part.id}: ${escapeHtml(part.title)}</h1>
    <p>${escapeHtml(part.objective)}</p>
    <div class="part-nav">
      ${renderPartNav(slug, parts, part.id, hasDocuments)}
    </div>
  </header>

  <main class="files-stack">
    ${fileBlocks || '<div class="empty">No walkthrough sections matched this part.</div>'}
  </main>

  <script src="https://unpkg.com/marked@12.0.2/marked.min.js"></script>
  <script src="https://unpkg.com/@highlightjs/cdn-assets@11.10.0/highlight.min.js"></script>
  <script>
    marked.setOptions({ gfm: true, breaks: false });
    for (const card of document.querySelectorAll('.annotation-card')) {
      const source = card.querySelector('.annotation-md-source');
      const target = card.querySelector('.annotation-md');
      if (!source || !target) continue;
      const markdown = source.value.trim();
      target.innerHTML = marked.parse(markdown);
    }
    for (const block of document.querySelectorAll('.line-code code')) {
      hljs.highlightElement(block);
    }
  </script>
  <script>window.__defIndex = ${JSON.stringify(defIndex)};</script>
  <script>${inlineJs}</script>
</body>
</html>`;
}

function renderIndexHtml(slug: string, title: string, parts: readonly WalkthroughPart[], partCounts: Map<number, number>, hasDocuments: boolean): string {
  const docsItem = hasDocuments
    ? `<li><a href="/${slug}/documents">Documents</a></li>\n`
    : "";
  const items = parts
    .map((part) => {
      const count = partCounts.get(part.id) ?? 0;
      return `<li><a href="/${slug}/part/${part.id}">Part ${part.id}: ${escapeHtml(part.title)}</a> <span class="ok">(${count} sections)</span></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/walkthrough.css" />
</head>
<body>
  <header class="topbar">
    <h1>${escapeHtml(title)}</h1>
    <p>Generated from multiline source comments in Part Plan order.</p>
  </header>
  <main style="padding: 16px; max-width: 900px;">
    <div class="annotation-card">
      <h3>Parts</h3>
      <ul>
        ${docsItem}${items}
      </ul>
    </div>
  </main>
</body>
</html>`;
}

type RenderedDocData = {
  filePath: string;
  html: string;
  headings: Array<{ id: string; text: string; level: number }>;
};

function renderDocumentsHtml(
  slug: string,
  parts: readonly WalkthroughPart[],
  documents: string[],
  renderedDocs: RenderedDocData[],
  inlineJs: string
): string {
  // Build tab bar
  const tabButtons = renderedDocs
    .map((doc, index) => {
      const fileName = doc.filePath.split("/").pop() ?? doc.filePath;
      const activeClass = index === 0 ? " active" : "";
      return `<button class="doc-tab-btn${activeClass}" data-doc-index="${index}">${escapeHtml(fileName)}</button>`;
    })
    .join("\n    ");

  // Build tab panes
  const tabPanes = renderedDocs
    .map((doc, index) => {
      const display = index === 0 ? "" : ' style="display:none"';
      return `<div class="doc-tab-pane" data-doc-index="${index}" data-doc-file="${escapeHtml(doc.filePath)}"${display}>
    <article class="doc-content">${doc.html}</article>
  </div>`;
    })
    .join("\n  ");

  // Build objective text from first part or default
  const objective = parts.length > 0 ? parts[0]!.objective : "Documentation for this walkthrough.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Documents - ${escapeHtml(slug)}</title>
  <link rel="stylesheet" href="/walkthrough.css" />
  <link rel="stylesheet" href="https://unpkg.com/@highlightjs/cdn-assets@11.10.0/styles/github-dark.min.css" />
</head>
<body data-slug="${escapeHtml(slug)}" data-part="0" data-page-type="documents">
  <header class="topbar">
    <h1>Documents</h1>
    <p>${escapeHtml(objective)}</p>
    <div class="part-nav">
      ${renderPartNav(slug, parts, 0, true)}
    </div>
  </header>

  <nav class="doc-tab-bar">
    ${tabButtons}
  </nav>

  <main class="doc-container">
    ${tabPanes}
  </main>

  <script src="https://unpkg.com/marked@12.0.2/marked.min.js"></script>
  <script src="https://unpkg.com/@highlightjs/cdn-assets@11.10.0/highlight.min.js"></script>
  <script>
    for (const block of document.querySelectorAll('.doc-content pre code')) {
      hljs.highlightElement(block);
    }
  </script>
  <script>
    window.__docHeadings = ${JSON.stringify(
      renderedDocs.map((d) => ({ file: d.filePath, headings: d.headings }))
    )};
  </script>
  <script>${inlineJs}</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/*  Markdown document rendering                                        */
/* ------------------------------------------------------------------ */

type RenderedDocument = {
  html: string;
  headings: Array<{ id: string; text: string; level: number }>;
  blockCount: number;
};

type ResolvedDocRef = {
  docIndex: number;
  anchor: string;
};

/**
 * Resolves a link href to another document in the walkthrough.
 * Returns null if the link is not a cross-document reference.
 */
function resolveDocRef(
  href: string,
  currentDocPath: string,
  allDocPaths: readonly string[]
): ResolvedDocRef | null {
  if (!href) return null;

  // Check if this is a link to another markdown file
  // Supports formats like: ./other.md, other.md, other.md#anchor
  let targetPath = href;
  let anchor = "";

  // Extract anchor if present
  const hashIndex = href.indexOf("#");
  if (hashIndex !== -1) {
    targetPath = href.slice(0, hashIndex);
    anchor = href.slice(hashIndex + 1);
  }

  // Normalize the target path
  // Handle relative paths starting with ./
  if (targetPath.startsWith("./")) {
    targetPath = targetPath.slice(2);
  }

  // Find the target document in allDocPaths
  for (let i = 0; i < allDocPaths.length; i++) {
    const docPath = allDocPaths[i]!;
    // Check for exact match or relative path match
    if (docPath === targetPath || docPath.endsWith("/" + targetPath) || docPath === "./" + targetPath) {
      // Don't resolve links to the current document
      if (docPath === currentDocPath) continue;
      return { docIndex: i, anchor };
    }
  }

  return null;
}

/**
 * Wraps block-level elements in .doc-block containers with sequential data-block-id attributes.
 */
function wrapBlocks(html: string, docIndex: number): { wrapped: string; blockCount: number } {
  const BLOCK_TAGS = /^<(h[1-6]|p|ul|ol|blockquote|pre|table|hr|details)[\s>]/i;

  const lines = html.split("\n");
  const result: string[] = [];
  let blockId = 0;
  let inBlock = false;
  let depth = 0;
  let currentTag = "";
  let blockLines: string[] = [];

  for (const line of lines) {
    if (!inBlock) {
      // Check if this line starts a block element
      const match = line.match(BLOCK_TAGS);
      if (match) {
        inBlock = true;
        currentTag = match[1]!.toLowerCase();
        depth = 1;
        blockLines = [line];

        // Check if this is a self-contained block on one line
        // For hr, or elements that close on the same line
        if (currentTag === "hr" || line.includes(`</${currentTag}>`)) {
          // Wrap the block
          result.push(
            `<div class="doc-block" data-block-id="${blockId}">`,
            `<div class="doc-block-gutter"></div>`,
            ...blockLines,
            `</div>`
          );
          blockId += 1;
          inBlock = false;
          blockLines = [];
          continue;
        }
      } else {
        // Not a block element, pass through
        result.push(line);
      }
    } else {
      // We're inside a block, track depth
      blockLines.push(line);

      // Count opening and closing tags for the current element
      // Use regex to find all occurrences of the current tag
      const openPattern = new RegExp(`<${currentTag}[\\s>]`, "gi");
      const closePattern = new RegExp(`</${currentTag}>`, "gi");

      const opens = (line.match(openPattern) || []).length;
      const closes = (line.match(closePattern) || []).length;

      // Adjust depth: add any additional opens, subtract closes
      // Initial depth=1 already counts the opening tag that started this block
      depth += opens;
      depth -= closes;

      if (depth <= 0) {
        // Block is complete, wrap it
        result.push(
          `<div class="doc-block" data-block-id="${blockId}">`,
          `<div class="doc-block-gutter"></div>`,
          ...blockLines,
          `</div>`
        );
        blockId += 1;
        inBlock = false;
        blockLines = [];
      }
    }
  }

  // Handle any remaining unclosed block (shouldn't happen with valid HTML)
  if (inBlock && blockLines.length > 0) {
    result.push(
      `<div class="doc-block" data-block-id="${blockId}">`,
      `<div class="doc-block-gutter"></div>`,
      ...blockLines,
      `</div>`
    );
    blockId += 1;
  }

  return { wrapped: result.join("\n"), blockCount: blockId };
}

/**
 * Renders a markdown document to HTML with block wrappers and cross-reference support.
 *
 * @param filePath - Absolute path to the markdown file
 * @param docIndex - Index of this document in the allDocPaths array
 * @param allDocPaths - Array of all document paths in the walkthrough
 * @returns Rendered document with HTML, headings, and block count
 */
function renderMarkdownDocument(
  filePath: string,
  docIndex: number,
  allDocPaths: readonly string[]
): RenderedDocument {
  const markdown = readFileSync(filePath, "utf-8");
  const headings: Array<{ id: string; text: string; level: number }> = [];

  // Get the relative path for this document (for cross-reference resolution)
  const relativePath = allDocPaths[docIndex] ?? filePath;

  // Create custom renderer
  const renderer = new Renderer();

  // Override heading to add IDs and collect headings for TOC
  renderer.heading = function (data: { text: string; depth: number }): string {
    const { text, depth } = data;
    // Generate slug from text
    const slug = text
      .toLowerCase()
      .replace(/[^\w]+/g, "-")
      .replace(/^-|-$/g, "");

    // Collect heading for TOC
    headings.push({ id: slug, text, level: depth });

    return `<h${depth} id="${slug}">${text}</h${depth}>`;
  };

  // Override code to add language class for highlight.js
  renderer.code = function (data: { text: string; lang?: string }): string {
    const { text, lang } = data;
    const langClass = lang ? ` class="language-${lang}"` : "";
    return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>`;
  };

  // Override link to resolve cross-document references
  renderer.link = function (data: { href: string; text: string }): string {
    const { href, text } = data;

    // Try to resolve as a cross-document reference
    const resolved = resolveDocRef(href, relativePath, allDocPaths);

    if (resolved) {
      // Cross-document link — use data attributes for client-side handling
      return `<a href="#" data-doc-ref="${resolved.docIndex}" data-doc-anchor="${resolved.anchor}">${text}</a>`;
    }

    // External link — open in new tab
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${text}</a>`;
  };

  // Parse markdown with custom renderer
  const rawHtml = marked.parse(markdown, { renderer }) as string;

  // Wrap blocks
  const { wrapped, blockCount } = wrapBlocks(rawHtml, docIndex);

  return {
    html: wrapped,
    headings,
    blockCount,
  };
}

/* ------------------------------------------------------------------ */
/*  Config validation                                                  */
/* ------------------------------------------------------------------ */

function loadAndValidateConfig(filePath: string): WalkthroughConfig {
  const resolved = resolve(filePath);
  const raw: unknown = JSON.parse(readFileSync(resolved, "utf-8"));

  if (!Value.Check(WalkthroughConfigSchema, raw)) {
    const errors = [...Value.Errors(WalkthroughConfigSchema, raw)];
    const messages = errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    throw new Error(`Invalid walkthrough config at ${resolved}:\n${messages}`);
  }

  return raw;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

export async function generate(configPath: string): Promise<void> {
  const config = loadAndValidateConfig(configPath);
  const { slug, title, parts, documents } = config;

  const rootDir = process.cwd();

  // Validate documents if present
  if (documents && documents.length > 0) {
    // Check for duplicates
    const seen = new Set<string>();
    for (const docPath of documents) {
      if (seen.has(docPath)) {
        throw new Error(`Duplicate document path: ${docPath}`);
      }
      seen.add(docPath);
    }

    // Validate each path ends with .md and exists
    for (const docPath of documents) {
      if (!docPath.endsWith(".md")) {
        throw new Error(`Document path must end with .md: ${docPath}`);
      }
      const fullPath = join(rootDir, docPath);
      if (!existsSync(fullPath)) {
        throw new Error(`Document file not found: ${docPath}`);
      }
    }

    console.log(`Documents: ${documents.length} files`);
  }
  const outDir = join(rootDir, "walkthrough");
  mkdirSync(outDir, { recursive: true });

  const files = uniqueFiles(parts);
  const sources = loadSources(rootDir, files);
  const sections = buildSections(parts, sources);
  const defIndex = buildDefinitionIndex(parts, sources);

  const assetsDir = getAssetsDir();
  const lineSelectJs = readFileSync(join(assetsDir, "line-select.js"), "utf-8");
  const commentClientJs = readFileSync(join(assetsDir, "comment-client.js"), "utf-8");
  const defLinkJs = readFileSync(join(assetsDir, "def-link.js"), "utf-8");
  const unresolvedJs = readFileSync(join(assetsDir, "unresolved-comments.js"), "utf-8");
  const exportJs = readFileSync(join(assetsDir, "export-comments.js"), "utf-8");
  const docTabsJs = readFileSync(join(assetsDir, "doc-tabs.js"), "utf-8");
  const blockSelectJs = readFileSync(join(assetsDir, "block-select.js"), "utf-8");
  const inlineJs = lineSelectJs + "\n" + commentClientJs + "\n" + defLinkJs + "\n" + unresolvedJs + "\n" + exportJs + "\n" + docTabsJs;
  const documentsInlineJs = blockSelectJs + "\n" + commentClientJs + "\n" + exportJs + "\n" + docTabsJs;

  console.log(`Definition index: ${Object.keys(defIndex).length} unique symbols`);

  const sectionsByPart = new Map<number, Section[]>();
  for (const part of parts) {
    sectionsByPart.set(part.id, []);
  }
  for (const section of sections) {
    sectionsByPart.get(section.partId)?.push(section);
  }

  const hasDocuments = !!(documents && documents.length > 0);
  const counts = new Map<number, number>();
  for (const part of parts) {
    const partSections = sectionsByPart.get(part.id) ?? [];
    counts.set(part.id, partSections.length);
    const html = renderPartHtml(slug, parts, part, partSections, inlineJs, defIndex, hasDocuments);
    writeFileSync(join(outDir, `walkthrough-part-${part.id}.html`), html);
  }

  const indexHtml = renderIndexHtml(slug, title, parts, counts, hasDocuments);
  writeFileSync(join(outDir, "index.html"), indexHtml);

  // Render documents page if documents are present
  if (documents && documents.length > 0) {
    const renderedDocs: RenderedDocData[] = documents.map((docPath, index) => {
      const fullPath = join(rootDir, docPath);
      const rendered = renderMarkdownDocument(fullPath, index, documents);
      return {
        filePath: docPath,
        html: rendered.html,
        headings: rendered.headings,
      };
    });

    const documentsHtml = renderDocumentsHtml(slug, parts, documents, renderedDocs, documentsInlineJs);
    writeFileSync(join(outDir, "documents.html"), documentsHtml);
    console.log(`Generated documents.html with ${documents.length} documents`);
  }

  // Copy CSS to output dir
  const css = readFileSync(join(assetsDir, "walkthrough.css"), "utf-8");
  writeFileSync(join(outDir, "walkthrough.css"), css);

  const summary = {
    generatedAt: new Date().toISOString(),
    slug,
    title,
    parts: parts.map((part) => ({
      id: part.id,
      title: part.title,
      files: part.files.length,
      sections: counts.get(part.id) ?? 0,
      output: `walkthrough-part-${part.id}.html`,
    })),
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(summary, null, 2) + "\n");

  console.log(`Generated ${parts.length} part files + index + manifest in ${outDir}`);
}
