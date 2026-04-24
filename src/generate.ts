import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { marked, Marked, Renderer, type Tokens } from "marked";

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
  /**
   * Opt out of the inlined comment-client bundle when the
   * consumer plans to ship their own (e.g. an encrypted or
   * SSO-gated comment system). Default: true. When false,
   * the ~30KB of comment + line-select scripts aren't
   * concatenated into the emitted pages.
   */
  comments: Type.Optional(Type.Boolean()),
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
/*  Annotation markdown renderer                                       */
/* ------------------------------------------------------------------ */

/**
 * Fixed-grammar identifier patterns we can hand-tokenize inside
 * inline `<code>` spans. hljs auto-detect mis-parses them because
 * `/`, `@`, `?`, `#` aren't operators in code-style grammars.
 * Pre-tokenizing lets consumers paint each segment (scheme /
 * type / ns / name / version / query / fragment) in its own
 * syntax colors without shipping a client-side classifier.
 */
const PURL_PATTERN =
  /^(pkg:)([A-Za-z][A-Za-z0-9.+-]*)(\/.+?)(@[^?#]+)?(\?[^#]+)?(#.+)?$/;

function tokenizePurlString(text: string): string | null {
  const match = PURL_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const [, scheme, type, path, version, query, fragment] = match;
  const span = (cls: string, content: string) =>
    `<span class="${cls}">${escapeHtml(content)}</span>`;
  const pathMatch = path!.match(/^\/(.+)\/([^/]+)$/);
  let pathHtml: string;
  if (pathMatch) {
    pathHtml =
      `/${span("purl-namespace", pathMatch[1]!)}/${span("purl-name", pathMatch[2]!)}`;
  } else {
    pathHtml = `/${span("purl-name", path!.slice(1))}`;
  }
  return (
    `<code class="purl">` +
    span("purl-scheme", scheme!) +
    span("purl-type", type!) +
    pathHtml +
    (version ? span("purl-version", version) : "") +
    (query ? span("purl-query", query) : "") +
    (fragment ? span("purl-fragment", fragment) : "") +
    `</code>`
  );
}

/**
 * Known JSDoc tags — only these wrap into .annotation-block cards.
 * Unknown `@foo` tokens in prose pass through untouched.
 */
const JSDOC_TAGS = new Set([
  "augments", "callback", "default", "deprecated", "description",
  "example", "extends", "fileoverview", "inheritdoc", "internal",
  "memberof", "module", "namespace", "override", "param",
  "private", "prop", "property", "protected", "public", "readonly",
  "return", "returns", "see", "since", "static", "template",
  "this", "throw", "throws", "type", "typedef",
]);

/**
 * Splits an annotation markdown string on JSDoc tag boundaries.
 * Each returned chunk is either a tag block (`kind: 'tag'`) or
 * preamble prose (`kind: 'prose'`). A tag block runs from its
 * `@tag` line up to (but not including) the next `@tag` line or
 * end-of-input, so multi-line @example bodies stay with their tag.
 */
function splitAnnotationByTags(
  markdown: string,
): Array<{ kind: "prose"; text: string } | {
  kind: "tag";
  tag: string;
  type: string | null;
  body: string;
}> {
  const lines = markdown.split("\n");
  const out: Array<
    | { kind: "prose"; text: string }
    | { kind: "tag"; tag: string; type: string | null; body: string }
  > = [];
  let buffer: string[] = [];
  let currentTag: { tag: string; type: string | null; body: string[] } | null =
    null;
  const flushProse = () => {
    if (buffer.length > 0 && buffer.join("").trim() !== "") {
      out.push({ kind: "prose", text: buffer.join("\n") });
    }
    buffer = [];
  };
  const flushTag = () => {
    if (currentTag) {
      out.push({
        kind: "tag",
        tag: currentTag.tag,
        type: currentTag.type,
        body: currentTag.body.join("\n").trim(),
      });
      currentTag = null;
    }
  };
  for (const line of lines) {
    const match = /^@([A-Za-z]+)(?:\s+(\{[^}]*\}))?\s*(.*)$/.exec(line.trim());
    if (match && JSDOC_TAGS.has(match[1]!.toLowerCase())) {
      flushProse();
      flushTag();
      currentTag = {
        tag: match[1]!.toLowerCase(),
        type: match[2] ?? null,
        body: match[3] ? [match[3]] : [],
      };
      continue;
    }
    if (currentTag) {
      currentTag.body.push(line);
    } else {
      buffer.push(line);
    }
  }
  flushProse();
  flushTag();
  return out;
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
  walkTokens(token: Tokens.Generic) {
    if (
      token.type === "link" &&
      typeof token.href === "string" &&
      token.href.startsWith("mailto:")
    ) {
      token.type = "text";
      token.text = token.raw;
    }
  },
});
/* PURL-shaped inline code gets hand-tokenized so consumers can
 * paint scheme / type / ns / name / version / query / fragment
 * with their own syntax colors. Non-PURL inline code falls
 * through to marked's default renderer (returning false from a
 * renderer hook signals "use the default"). */
annotationMarked.use({
  renderer: {
    codespan(token: Tokens.Codespan): string | false {
      return tokenizePurlString(token.text) ?? false;
    },
  },
});

function renderAnnotationMarkdown(markdown: string): string {
  const chunks = splitAnnotationByTags(markdown.trim());
  const blocks: Array<{ html: string; order: number }> = [];
  let preamble: string | null = null;
  let hasExplicitDescription = false;

  for (const chunk of chunks) {
    if (chunk.kind === "prose") {
      if (preamble === null) {
        preamble = chunk.text;
      } else {
        preamble = `${preamble}\n\n${chunk.text}`;
      }
      continue;
    }
    if (chunk.tag === "description") {
      hasExplicitDescription = true;
    }
    const typeHtml = chunk.type
      ? `<code class="annotation-type">${escapeHtml(chunk.type)}</code>`
      : "";
    const bodyHtml = chunk.body
      ? (annotationMarked.parse(chunk.body) as string)
      : "";
    const order =
      chunk.tag === "fileoverview" ? 0 : chunk.tag === "description" ? 1 : 2;
    blocks.push({
      html:
        `<div class="annotation-block" data-tag="${chunk.tag}">` +
        `<span class="annotation-tag">@${chunk.tag}</span>` +
        (typeHtml ? ` ${typeHtml}` : "") +
        `<div class="annotation-body">${bodyHtml}</div>` +
        `</div>`,
      order,
    });
  }
  /* Preamble becomes a synthetic @description when no explicit
   * one exists. Keeps the "description leads the card stack"
   * ordering while still surfacing free-floating prose. */
  if (preamble !== null && !hasExplicitDescription) {
    const bodyHtml = annotationMarked.parse(preamble) as string;
    blocks.push({
      html:
        `<div class="annotation-block" data-tag="description">` +
        `<span class="annotation-tag">@description</span>` +
        `<div class="annotation-body">${bodyHtml}</div>` +
        `</div>`,
      order: 1,
    });
  } else if (preamble !== null) {
    /* Explicit @description exists — keep the preamble as plain
     * prose above the cards so nothing is silently dropped. */
    const bodyHtml = annotationMarked.parse(preamble) as string;
    blocks.unshift({ html: `<div class="annotation-prose">${bodyHtml}</div>`, order: -1 });
  }
  blocks.sort((a, b) => a.order - b.order);
  return blocks.map(b => b.html).join("");
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
  basePath: string,
): string {
  const docsLink = hasDocuments
    ? `<a class="${activePartId === 0 ? "active" : ""}" href="${basePath}/${slug}/documents">Documents</a>\n`
    : "";
  const partLinks = parts
    .map((part) => {
      const cls = part.id === activePartId ? "active" : "";
      return `<a class="${cls}" href="${basePath}/${slug}/part/${part.id}">Part ${part.id}</a>`;
    })
    .join("\n");
  return docsLink + partLinks;
}



function renderPartHtml(slug: string, parts: readonly WalkthroughPart[], part: WalkthroughPart, sections: readonly Section[], inlineJs: string, defIndex: DefinitionIndex, hasDocuments: boolean, basePath: string, cssHref: string): string {
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

          const annotationHtml = renderAnnotationMarkdown(section.annotation);
          return `<article class="annotation-card" id="ann-${section.id}">
  <div class="annotation-md">${annotationHtml}</div>
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
  <link rel="stylesheet" href="${cssHref}" />
  <link rel="stylesheet" href="https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/github-dark.min.css" />
</head>
<body data-slug="${escapeHtml(slug)}" data-part="${part.id}">
  <header class="topbar">
    <h1>Part ${part.id}: ${escapeHtml(part.title)}</h1>
    <p>${escapeHtml(part.objective)}</p>
    <div class="part-nav">
      ${renderPartNav(slug, parts, part.id, hasDocuments, basePath)}
    </div>
  </header>

  <main class="files-stack">
    ${fileBlocks || '<div class="empty">No walkthrough sections matched this part.</div>'}
  </main>

  <script src="https://unpkg.com/@highlightjs/cdn-assets@11.11.1/highlight.min.js"></script>
  <script>
    for (const block of document.querySelectorAll('.line-code code')) {
      hljs.highlightElement(block);
    }
  </script>
  <script>window.__defIndex = ${JSON.stringify(defIndex)};</script>
  <script>${inlineJs}</script>
</body>
</html>`;
}

function renderIndexHtml(slug: string, title: string, parts: readonly WalkthroughPart[], partCounts: Map<number, number>, hasDocuments: boolean, basePath: string, cssHref: string): string {
  const docsItem = hasDocuments
    ? `<li><a href="${basePath}/${slug}/documents">Documents</a></li>\n`
    : "";
  const items = parts
    .map((part) => {
      const count = partCounts.get(part.id) ?? 0;
      return `<li><a href="${basePath}/${slug}/part/${part.id}">Part ${part.id}: ${escapeHtml(part.title)}</a> <span class="ok">(${count} sections)</span></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${cssHref}" />
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
  inlineJs: string,
  basePath: string,
  cssHref: string,
): string {
  // Build tab bar
  const tabButtons = renderedDocs
    .map((doc, index) => {
      const fileName = doc.filePath.split("/").pop() ?? doc.filePath;
      const activeClass = index === 0 ? " active" : "";
      return `<button class="doc-tab-btn${activeClass}" data-doc-index="${index}">${escapeHtml(fileName)}</button>`;
    })
    .join("\n    ");

  // Build tab panes — first pane gets the "active" class so CSS display:none
  // doesn't hide it before doc-tabs.js initialises.
  const tabPanes = renderedDocs
    .map((doc, index) => {
      const activeClass = index === 0 ? " active" : "";
      const display = index === 0 ? "" : ' style="display:none"';
      return `<div class="doc-tab-pane${activeClass}" data-doc-index="${index}" data-doc-file="${escapeHtml(doc.filePath)}"${display}>
    <article class="doc-content">${doc.html}</article>
  </div>`;
    })
    .join("\n  ");

  // Generic description for the documents section header
  const objective = "Reference documents for this walkthrough.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Documents - ${escapeHtml(slug)}</title>
  <link rel="stylesheet" href="${cssHref}" />
  <link rel="stylesheet" href="https://unpkg.com/@highlightjs/cdn-assets@11.11.1/styles/github-dark.min.css" />
</head>
<body data-slug="${escapeHtml(slug)}" data-part="0" data-page-type="documents">
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

  <script src="https://unpkg.com/@highlightjs/cdn-assets@11.11.1/highlight.min.js"></script>
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

/**
 * Converts arbitrary text to a heading ID slug — the same transformation
 * used by the heading renderer and by link anchor normalisation, so
 * cross-reference anchors always match the generated heading IDs.
 */
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "");
}

type RenderedDocument = {
  html: string;
  headings: Array<{ id: string; text: string; level: number }>;
  blockCount: number;
};

type ResolvedDocRef = {
  docIndex: number;
  anchor: string;
  /** True when the link targets the same document it appears in. */
  sameDoc?: boolean;
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
  // Supports formats like: ./other.md, other.md, ../other.md, other.md#anchor
  let targetPath = href;
  let anchor = "";

  // Extract anchor if present and slugify it so it matches the generated
  // heading ID (e.g. "C++ Design" → "c-design", same as the heading renderer).
  const hashIndex = href.indexOf("#");
  if (hashIndex !== -1) {
    targetPath = href.slice(0, hashIndex);
    const rawAnchor = href.slice(hashIndex + 1);
    // Only slugify if the anchor looks like a heading text; if it's already a
    // valid slug (all lowercase word chars and hyphens) leave it as-is.
    anchor = /^[a-z0-9-]+$/.test(rawAnchor) ? rawAnchor : slugifyHeading(rawAnchor);
  }

  // Must reference a markdown file
  if (!targetPath.endsWith(".md")) return null;

  // Resolve the target path relative to the current document's directory.
  // This handles ./, ../, and plain filenames uniformly.
  // All doc paths use forward slashes (they come from the config JSON).
  const currentDir = dirname(currentDocPath).replace(/\\/g, "/");
  const base = currentDir === "." ? targetPath : `${currentDir}/${targetPath}`;
  // Normalize away any ../ or ./ segments, keeping forward slashes
  const resolvedTarget = base
    .split("/")
    .reduce((acc: string[], seg) => {
      if (seg === "..") acc.pop();
      else if (seg !== ".") acc.push(seg);
      return acc;
    }, [])
    .join("/");

  // Find the target document in allDocPaths
  for (let i = 0; i < allDocPaths.length; i++) {
    const docPath = allDocPaths[i]!;
    // Normalize stored doc path: forward slashes, no leading ./
    const normalizedDocPath = docPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalizedDocPath === resolvedTarget) {
      // Link targets this document — treat as a same-doc anchor
      if (docPath === currentDocPath) return { docIndex: i, anchor, sameDoc: true };
      return { docIndex: i, anchor };
    }
  }

  return null;
}

/**
 * Wraps block-level elements in .doc-block containers with sequential data-block-id attributes.
 */
function wrapBlocks(html: string): { wrapped: string; blockCount: number } {
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

        // Check if this is a self-contained block on one line.
        // For <hr> (void element) or any element whose opening line already
        // contains the matching close tag, count open/close tag occurrences
        // using regex — more robust than a plain string search which could
        // match closing tags inside attribute values or text content.
        const openPat = new RegExp(`<${currentTag}[\\s>]`, "gi");
        const closePat = new RegExp(`</${currentTag}>`, "gi");
        const opensOnLine = (line.match(openPat) || []).length;
        const closesOnLine = (line.match(closePat) || []).length;
        if (currentTag === "hr" || closesOnLine >= opensOnLine) {
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

  // Track seen heading slugs for deduplication
  const seenSlugs = new Map<string, number>();

  // Override heading to add IDs and collect headings for TOC.
  // In marked v17, data.text is raw markdown — use marked.parseInline() to
  // render inline formatting (bold, code, etc.) and strip tags for plain text.
  renderer.heading = function (data: { text: string; depth: number }): string {
    const { text, depth } = data;
    // Render inline markdown (e.g. **bold**, `code`) to HTML
    const renderedText = marked.parseInline(text) as string;
    // Strip HTML tags for the slug and TOC display text
    const plainText = renderedText.replace(/<[^>]*>/g, "");
    let slug = slugifyHeading(plainText);

    // Deduplicate: append -1, -2, ... for repeated slugs (GitHub convention).
    const count = seenSlugs.get(slug) ?? 0;
    seenSlugs.set(slug, count + 1);
    if (count > 0) {
      slug = `${slug}-${count}`;
    }

    // Collect heading for TOC with plain text (no HTML tags)
    headings.push({ id: slug, text: plainText, level: depth });

    // Trailing \n ensures wrapBlocks sees this as its own line, not merged
    // with the next block element
    return `<h${depth} id="${escapeHtml(slug)}">${renderedText}</h${depth}>\n`;
  };

  // Override code to add language class for highlight.js.
  // Escape lang to prevent attribute injection, and add trailing \n.
  renderer.code = function (data: { text: string; lang?: string }): string {
    const { text, lang } = data;
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>\n`;
  };

  // Override link to resolve cross-document references.
  // In marked v17, data.text is raw markdown — use marked.parseInline() to
  // render inline formatting within link text.
  renderer.link = function (data: { href: string; text: string }): string {
    const { href, text } = data;
    const renderedText = marked.parseInline(text) as string;

    // Same-document anchor link (e.g. #section-one) — render as plain anchor
    if (href.startsWith("#")) {
      return `<a href="${escapeHtml(href)}">${renderedText}</a>`;
    }

    // Try to resolve as a cross-document reference
    const resolved = resolveDocRef(href, relativePath, allDocPaths);

    if (resolved) {
      if (resolved.sameDoc) {
        if (resolved.anchor) {
          // Same document with anchor — plain in-page link
          return `<a href="#${escapeHtml(resolved.anchor)}">${renderedText}</a>`;
        }
        // Same document, no anchor — render as non-navigating inline text
        // to avoid href="#" scrolling the page to the top.
        return `<span class="doc-self-link">${renderedText}</span>`;
      }
      // Cross-document link — use data attributes for client-side handling
      return `<a href="#" data-doc-ref="${resolved.docIndex}" data-doc-anchor="${escapeHtml(resolved.anchor)}">${renderedText}</a>`;
    }

    // External link — open in new tab
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${renderedText}</a>`;
  };

  // Parse markdown with custom renderer
  const rawHtml = marked.parse(markdown, { renderer }) as string;

  // Wrap blocks
  const { wrapped, blockCount } = wrapBlocks(rawHtml);

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

export type GenerateOptions = {
  /**
   * URL path prefix. When the site is hosted under a subpath
   * (e.g. GitHub Pages at `/my-repo/`), every emitted `href` /
   * `src` to a same-site asset is rewritten from `/walkthrough.css`
   * to `{basePath}/walkthrough.css`. It's a path, not a URL —
   * matches Next.js `basePath` semantics, not Vite's `base`
   * (which allows full URLs).
   * Default: "" (site hosted at origin root).
   */
  basePath?: string | undefined;
  /**
   * Subdirectory under the output dir where emitted static
   * assets (currently `walkthrough.css`) land. Default: ""
   * (emit flat). Example: `--asset-dir assets` writes
   * `assets/walkthrough.css` and rewrites the <link href>.
   */
  assetDir?: string | undefined;
};

/**
 * Normalise a user-supplied base path so it starts with `/` and
 * has no trailing slash. Empty input → empty string (no prefixing).
 */
function normaliseBasePath(basePath: string | undefined): string {
  if (!basePath) {
    return "";
  }
  let out = basePath.trim();
  if (out === "" || out === "/") {
    return "";
  }
  if (!out.startsWith("/")) {
    out = "/" + out;
  }
  return out.replace(/\/$/, "");
}

/**
 * Normalise a user-supplied asset dir — drop any leading/trailing
 * slashes so we can join it cleanly, and collapse empty values.
 */
function normaliseAssetDir(assetDir: string | undefined): string {
  if (!assetDir) {
    return "";
  }
  return assetDir.trim().replace(/^\/+|\/+$/g, "");
}

export async function generate(
  configPath: string,
  options: GenerateOptions = { __proto__: null } as GenerateOptions,
): Promise<void> {
  const config = loadAndValidateConfig(configPath);
  const { slug, title, parts, documents } = config;
  const basePath = normaliseBasePath(options.basePath);
  const assetDir = normaliseAssetDir(options.assetDir);
  /* URL prefix for asset <href>/<src>: `{basePath}/{assetDir}/`.
   * Both parts are optional. Empty → assets at site root, flat. */
  const assetHref = (filename: string): string => {
    const segments = [basePath, assetDir, filename]
      .map(p => p.replace(/^\/+|\/+$/g, ""))
      .filter(Boolean);
    return "/" + segments.join("/");
  };

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

  const bundledAssetsDir = getAssetsDir();
  /* Non-comment scripts — always inlined (line-select is nav-ish
   * UX, def-link is the definition-jump feature, doc-tabs/doc-toc
   * power the documents page layout). */
  const lineSelectJs = readFileSync(join(bundledAssetsDir, "line-select.js"), "utf-8");
  const defLinkJs = readFileSync(join(bundledAssetsDir, "def-link.js"), "utf-8");
  const docTabsJs = readFileSync(join(bundledAssetsDir, "doc-tabs.js"), "utf-8");
  const blockSelectJs = readFileSync(join(bundledAssetsDir, "block-select.js"), "utf-8");
  const docTocJs = readFileSync(join(bundledAssetsDir, "doc-toc.js"), "utf-8");
  /* Comment-client bundle — only inlined when comments are
   * enabled. Consumers shipping their own system (e.g. encrypted
   * or SSO-gated) can set `comments: false` in walkthrough.json
   * to drop the default client + its API-endpoint assumptions. */
  const commentsEnabled = config.comments !== false;
  const commentClientJs = commentsEnabled
    ? readFileSync(join(bundledAssetsDir, "comment-client.js"), "utf-8")
    : "";
  const unresolvedJs = commentsEnabled
    ? readFileSync(join(bundledAssetsDir, "unresolved-comments.js"), "utf-8")
    : "";
  const exportJs = commentsEnabled
    ? readFileSync(join(bundledAssetsDir, "export-comments.js"), "utf-8")
    : "";
  const inlineJs = commentsEnabled
    ? [lineSelectJs, commentClientJs, defLinkJs, unresolvedJs, exportJs].join("\n")
    : [lineSelectJs, defLinkJs].join("\n");
  const documentsInlineJs = commentsEnabled
    ? [blockSelectJs, commentClientJs, unresolvedJs, exportJs, docTabsJs, docTocJs].join("\n")
    : [blockSelectJs, docTabsJs, docTocJs].join("\n");

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
    const html = renderPartHtml(slug, parts, part, partSections, inlineJs, defIndex, hasDocuments, basePath, assetHref("walkthrough.css"));
    writeFileSync(join(outDir, `walkthrough-part-${part.id}.html`), html);
  }

  const indexHtml = renderIndexHtml(slug, title, parts, counts, hasDocuments, basePath, assetHref("walkthrough.css"));
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

    const documentsHtml = renderDocumentsHtml(slug, parts, documents, renderedDocs, documentsInlineJs, basePath, assetHref("walkthrough.css"));
    writeFileSync(join(outDir, "documents.html"), documentsHtml);
    console.log(`Generated documents.html with ${documents.length} documents`);
  }

  /* Copy CSS to output dir — under `assetDir` if configured,
   * else at output root. `bundledAssetsDir` (declared above) is
   * the npm-package-bundled asset *source* path; `assetDir` is
   * the user-chosen emit subdir. */
  const css = readFileSync(join(bundledAssetsDir, "walkthrough.css"), "utf-8");
  const cssOutDir = assetDir ? join(outDir, assetDir) : outDir;
  mkdirSync(cssOutDir, { recursive: true });
  writeFileSync(join(cssOutDir, "walkthrough.css"), css);

  const summary = {
    generatedAt: new Date().toISOString(),
    slug,
    title,
    hasDocuments: hasDocuments,
    documents: documents ?? [],
    parts: parts.map((part) => {
      const partSections = sectionsByPart.get(part.id) ?? [];
      return {
        id: part.id,
        title: part.title,
        files: part.files.length,
        sections: counts.get(part.id) ?? 0,
        output: `walkthrough-part-${part.id}.html`,
        /* Per-section metadata for consumers that want to reshape
         * the tour without reparsing emitted HTML. Additive to
         * the earlier shape — `sections: <count>` stays for
         * backwards compat; full records live under `sectionList`. */
        sectionList: partSections.map((s) => ({
          id: s.id,
          file: s.file,
          startLine: s.startLine,
          endLine: s.endLine,
        })),
      };
    }),
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(summary, null, 2) + "\n");

  console.log(`Generated ${parts.length} part files + index + manifest in ${outDir}`);
}
