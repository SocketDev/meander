/**
 * Inline-code classifiers for annotation rendering. Each
 * predicate tests a string against the shape of one well-known
 * identifier kind so `renderAnnotationMarkdown` can emit
 * semantically-classed <code> spans instead of a single
 * bucket. Predicates are deliberately shape-only — we paint
 * what looks right, we don't validate. Ordered alphabetically
 * so new predicates land in a stable spot.
 *
 * Exports:
 *
 * - IsEmail - user@domain.tld
 * - IsPurl - pkg:type/ns/name@ver?q#frag
 * - IsScopedPackage - @babel/core
 * - IsUrl - scheme://host/... (absolute)
 */

/* RFC 3986 unreserved + pct-encoded + sub-delims + ":" + "@" — the
 * `pchar` character class PURLs lean on. Factored out so the
 * purl regex doesn't restate it. Matches for one character. */
const PCHAR = "A-Za-z0-9\\-._~!$&'()*+,;=:@%"

/* Reused by isPurl. Query chars are pchar minus '&' and '#'
 * (these delimit pairs and fragments); version chars are pchar
 * minus '?' and '#' (these open query / fragment). */
const PURL_QCHAR = "A-Za-z0-9\\-._~!$'()*+,;=:@%"
const PURL_VCHAR = "A-Za-z0-9\\-._~!$&'()*+,;=:@%"

const PURL_PATH_SEG = `[${PCHAR}]+`
export const PURL_RE = new RegExp(
  `^(pkg:)` +
    `([A-Za-z][A-Za-z0-9.+\\-]*)` + // type
    `((?:\\/${PURL_PATH_SEG})+)` + // path
    `(@[${PURL_VCHAR}]+)?` + // version
    `(\\?[${PURL_QCHAR}]+(?:&[${PURL_QCHAR}]+)*)?` + // query
    `(#(?:[${PCHAR}]+)(?:\\/[${PCHAR}]+)*)?` + // fragment
    `$`,
)

/* HTML5 email input validator's pattern, tightened so the TLD
 * must contain at least one letter. This matters: a version
 * string like `core@7.0.0` passes the WHATWG shape check
 * (TLD `0` is one alphanumeric char) but obviously isn't an
 * email. Requiring `[A-Za-z]{2,}` in the final dotted segment
 * distinguishes `alice@example.com` (real) from `core@7.0.0`
 * (package identifier). */
const EMAIL_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/

/* Scoped npm / jsr package shape: `@scope/name`. Scope and
 * name use the npm package-name character class (minus leading
 * `.` / `_`). */
const SCOPED_PACKAGE_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i

/* Absolute URL with a scheme. Sub-delims + '%' allow encoded
 * chars; `?` / `#` open query / fragment. Permissive on path/
 * query/fragment chars since the regex is a shape check, not a
 * spec validator. */
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+$/

export function isEmail(text: string): boolean {
  return EMAIL_RE.test(text)
}

export function isPurl(text: string): boolean {
  return PURL_RE.test(text)
}

export function isScopedPackage(text: string): boolean {
  return SCOPED_PACKAGE_RE.test(text)
}

export function isUrl(text: string): boolean {
  return URL_RE.test(text)
}
