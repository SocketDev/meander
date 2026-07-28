# Changelog

## [Unreleased]

### Added

- **`ui`** — only the word "meander" is linked in the footer tagline
- trail index layout, popover a11y, and footer tagline rotation
- **`ux`** — trail vocabulary, popover registry, lazy auth widget
- **`ui`** — perceived-perf and visual polish pass
- **`skills`** — port updating + content-filename-from-title from socket-packageurl-js
- **`skills`** — port quality-scan + quality-loop + refactor-cleaner from socket-packageurl-js
- **`skills`** — port security-scan + reviewers from socket-packageurl-js
- **`blob-key`** — walkthrough-blob wrapping-key ceremony
- **`db-key`** — comment-store wrapping-key ceremony
- **`val`** — comment-store envelope encryption + opt-in blob envelope
- **`crypto`** — envelope encryption primitives + publish opt-in
- **`shamir`** — GF(2^8) secret-sharing for custodial key recovery
- **`auth`** — replace basic auth with email magic-code + JWT sessions
- **`generate`** — honor styles + theme opt-outs at emit time
- **`cli`** — parseArgs + esbuild bundle, consumer examples, token-scope docs
- **`test`** — vitest + coverage pipeline, unified config, repo cleanup
- **`cli`** — add \`meander doctor\` diagnostic command
- **`a11y`** — view-transitions + reduced-motion + annotation-md fallback
- **`comments`** — route to a Val Town backend when hosted off-origin
- **`urls`** — post-emit basePath rewrite + polish index hero
- **`minify`** — opt-in JS/CSS/SVG minification pass
- **`dev`** — add --watch mode to the local preview script
- **`docs`** — rich doc entries with filename, title, summary
- **`nav`** — enhance part-nav with topics label + compact titles
- **`boot`** — flag Safari via html[data-ua="safari"]
- **`theme`** — add Neo-Kijū theme (purple mech-beast palette)
- **`tokenizers`** — pluggable inline-code tokenizer registry
- **`footer`** — add default footer with meander attribution
- **`index`** — hero panel + card-grid TOC on the index page
- **`index`** — optional size-tier badges on the TOC
- **`urls`** — optional filename field for clean part URLs
- **`llms`** — emit llms.txt and llms-full.txt for LLM agents
- **`sw`** — optional service worker for offline cache
- **`security`** — SRI injection + CSP meta generation
- **`mermaid`** — build-time pre-render of \`\`\`mermaid code blocks
- **`pages`** — per-file sections menu + per-chunk section chips
- **`jsdoc`** — wrap @tags + group into per-tag blocks in annotations
- **`hotlinks`** — Cmd/Ctrl-click URLs and cross-file paths in code
- **`prose`** — add HTML prose polishers for rendered docs
- **`pages`** — add column splitter, jump-to-file menu, theme toggle
- **`cdn`** — add sri to hljs cdn assets and load typescript grammar
- **`cli`** — serve command + dev script for local preview
- **`brand`** — add favicon set with walkthrough.json override schema
- **`brand`** — add logo asset set and feature in readme
- **`render`** — classify inline code as email, purl, scoped package, or url
- **`render`** — emit file-anchors.json for cross-file link targets
- **`render`** — include per-section metadata in manifest.json
- **`cli`** — --base-path and --asset-dir for subpath hosting + asset subdir
- **`render`** — hand-tokenize purl identifiers in inline code
- **`render`** — emit structured annotation-block cards per jsdoc tag
- encryption-at-rest
- **`documents`** — add TOC, cross-references, and publishing pipeline
- **`documents`** — add comment system integration for documents
- **`documents`** — add block selection system for documents
- **`documents`** — add document page styling and CSS
- **`documents`** — add documents page generation and navigation
- **`documents`** — add config schema and markdown rendering engine
- add export comments feature with JSON export
- unresolved comments dropdown
- initial release

### Fixed

- **`fuzz`** — sweep orphaned vitiate shm segments before the run
- **`readme`** — reconcile the coverage badge with measured coverage
- **`types`** — extend the fleet tsconfig base
- **`paths`** — normalize doc.filePath before splitting on slash
- **`types`** — clear tsc errors under the fleet check tsconfig
- **`repo`** — plain doc-header blocks and skill descriptions within catalog budget
- **`claude`** — segment agents/commands/skills into repo/ and drop stale shadows
- **`minify`** — hoist required kind out of the minifyAsset options bag
- **`a11y`** — drop redundant title attrs on topbar action buttons
- **`ui`** — unresolved-comments dropdown sizes to its content
- **`ui`** — paint pair-grid code column as one continuous dark band
- **`claude`** — clear AgentShield medium+ findings from ported agents
- **`minify`** — dynamic-import esbuild so JS/CSS pass degrades gracefully
- **`render`** — drop mailto auto-link for name@version patterns in annotations
- **`documents`** — make tab bar horizontally scrollable with fade indicator
- **`documents`** — harden rendering, API validation, and client-side navigation

### Internal

- **`config`** — comments: false to skip inlined comment client
- **`deps`** — absorb the fleet catalog heal
- **`fleet`** — restore fetch-fleet-bundle to the v1.0.14 manifest bytes
- **`ci`** — reference the agentshield binary env the install composite exports
- **`deps`** — sync the sdk-stable alias to the 4.1.0 catalog pin
- **`ci`** — converge on the fleet checkout v6.0.2 pin and stamp the pages pins
- **`deps`** — ignore vite's optional esbuild peer and regen the lockfile
- **`deps`** — resolve dependabot security alerts for svgo and js-yaml
- **`deps`** — pin vite 8 rolldown-native and sync the -stable aliases
- **`deps`** — sync package-manager pins and regenerate the lockfile snapshot
- **`deps`** — resolve dependabot security alerts
- **`ci`** — drop ecc-agentshield package.json resolve, use bin shim
- **`ci`** — resolve puppeteer build-script approval that broke install
