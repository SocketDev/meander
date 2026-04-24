/** @fileoverview Unit tests for inline-code classifiers. */

import { describe, expect, it } from 'vitest'

import {
  _PURL_RE,
  isEmail,
  isPurl,
  isScopedPackage,
  isUrl,
} from '../src/classifiers.mts'

describe('isEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isEmail('alice@example.com')).toBe(true)
    expect(isEmail('bob.smith+tag@mail.co.uk')).toBe(true)
  })

  it('rejects purl-shaped package@version', () => {
    /* Regression: `core@7.0.0` has the email shape but a
     * numeric-only TLD. Without the `[A-Za-z]{2,}` guard the
     * classifier used to paint every `foo@x.y` pill as email. */
    expect(isEmail('core@7.0.0')).toBe(false)
    expect(isEmail('lodash@4.17.21')).toBe(false)
  })

  it('rejects missing local-part or domain', () => {
    expect(isEmail('@example.com')).toBe(false)
    expect(isEmail('alice@')).toBe(false)
    expect(isEmail('no-at-sign')).toBe(false)
  })

  it('rejects short TLDs', () => {
    expect(isEmail('a@b.c')).toBe(false)
  })
})

describe('isUrl', () => {
  it('accepts http/https/ftp', () => {
    expect(isUrl('https://example.com')).toBe(true)
    expect(isUrl('http://localhost:8080/path?q=1')).toBe(true)
    expect(isUrl('ftp://files.example.com/pub')).toBe(true)
  })

  it('accepts custom schemes', () => {
    expect(isUrl('ws://example.com')).toBe(true)
    expect(isUrl('git+https://github.com/a/b')).toBe(true)
  })

  it('rejects relative paths and bare strings', () => {
    expect(isUrl('/path')).toBe(false)
    expect(isUrl('./foo')).toBe(false)
    expect(isUrl('example.com')).toBe(false)
    expect(isUrl('not a url at all')).toBe(false)
  })

  it('rejects strings with whitespace/quotes/brackets', () => {
    expect(isUrl('http://foo bar.com')).toBe(false)
    expect(isUrl('http://foo"bar.com')).toBe(false)
  })
})

describe('isScopedPackage', () => {
  it('accepts @scope/name form', () => {
    expect(isScopedPackage('@babel/core')).toBe(true)
    expect(isScopedPackage('@sindresorhus/is')).toBe(true)
    expect(isScopedPackage('@divmain/meander')).toBe(true)
  })

  it('rejects unscoped packages', () => {
    expect(isScopedPackage('lodash')).toBe(false)
    expect(isScopedPackage('react')).toBe(false)
  })

  it('rejects malformed scope strings', () => {
    expect(isScopedPackage('@/name')).toBe(false)
    expect(isScopedPackage('@scope/')).toBe(false)
    expect(isScopedPackage('scope/name')).toBe(false)
    expect(isScopedPackage('@.scope/name')).toBe(false)
  })
})

describe('isPurl', () => {
  it('accepts canonical purl shapes', () => {
    expect(isPurl('pkg:npm/lodash@4.17.21')).toBe(true)
    expect(isPurl('pkg:pypi/requests@2.28.1')).toBe(true)
    expect(isPurl('pkg:maven/org.springframework/spring-core@5.3.21')).toBe(
      true,
    )
  })

  it('accepts purls with qualifiers + fragments', () => {
    expect(
      isPurl('pkg:npm/lodash@4.17.21?classifier=sources#src/index.js'),
    ).toBe(true)
  })

  it('accepts purl without version', () => {
    expect(isPurl('pkg:generic/something')).toBe(true)
  })

  it('rejects non-purl strings', () => {
    expect(isPurl('npm/lodash')).toBe(false)
    expect(isPurl('pkg:/')).toBe(false)
    expect(isPurl('pkg:npm/')).toBe(false)
    expect(isPurl('https://example.com')).toBe(false)
  })

  it('_PURL_RE exposes capture groups for tokenizers', () => {
    const m = 'pkg:npm/lodash@4.17.21?q=x#frag'.match(_PURL_RE)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('pkg:')
    expect(m![2]).toBe('npm')
    /* Group 3 is the full path; because `@` is a pchar, the
     * version token gets absorbed here when it appears inside
     * a path segment. Consumers slice on '@' if they need the
     * base-name split. */
    expect(m![3]).toContain('/lodash')
    expect(m![5]).toBe('?q=x')
    expect(m![6]).toBe('#frag')
  })
})
