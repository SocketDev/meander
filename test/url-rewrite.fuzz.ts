/**
 * @file Vitiate coverage-guided fuzz target (Tier 2) for src/url-rewrite — the
 *   untrusted-HTML rewrite boundary. `applyBasePathToHtml(html, basePath)`
 *   feeds `html` straight into node-html-parser and walks every [href]/[src]
 *   attribute. Complements the fast-check property tests in
 *   url-rewrite.fuzz.test.mts: fast-check checks the documented contracts on
 *   HTML CONSTRUCTED from a fixed template; vitiate feeds SWC-coverage-guided
 *   mutated BYTES straight into the parser to reach malformed-markup paths a
 *   spec-based test never hits, with the prototypePollution detector watching
 *   the attribute walk. Run via `pnpm run test:fuzz`.
 */

import { fuzz } from '@vitiate/core'

import { applyBasePathToHtml } from '../src/url-rewrite.mts'

// `applyBasePathToHtml` documents a NEVER-THROWS contract: any (html, basePath)
// pair yields a string. It is documented-total, so we wrap nothing — any thrown
// error on arbitrary bytes is a crash the fuzzer must surface. A non-empty
// basePath is passed so the rewriting branch (not the empty-basePath early
// return) is exercised.
fuzz('applyBasePathToHtml never throws on arbitrary HTML bytes', data => {
  applyBasePathToHtml(data.toString('utf8'), '/base')
})
