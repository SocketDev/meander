/**
 * @file Vitiate coverage-guided fuzz target (Tier 2) for src/classifiers — the
 *   untrusted annotation-text classifier boundary. The four predicates
 *   (`isEmail`, `isPurl`, `isScopedPackage`, `isUrl`) run shape-only regexes
 *   over arbitrary inline-code text. Complements the fast-check property tests
 *   in classifiers.fuzz.test.mts: fast-check checks the documented verdicts on
 *   strings CONSTRUCTED from clean alphabets; vitiate feeds SWC-coverage-guided
 *   mutated BYTES through each regex to hunt for a crash or catastrophic-
 *   backtracking (ReDoS) hang that a spec-based test never reaches. Run via
 *   `pnpm run test:fuzz`.
 */

import { fuzz } from '@vitiate/core'

import { isEmail, isPurl, isScopedPackage, isUrl } from '../src/classifiers.mts'

// Every predicate documents a NEVER-THROWS contract (returns a boolean for any
// string, no ReDoS hang within the run budget). They are documented-total, so
// we wrap nothing — a throw or a fuzz-budget-blowing hang on arbitrary bytes is
// a real crash the fuzzer must surface.
fuzz('classifiers never throw on arbitrary bytes', data => {
  const text = data.toString('utf8')
  isEmail(text)
  isPurl(text)
  isScopedPackage(text)
  isUrl(text)
})
