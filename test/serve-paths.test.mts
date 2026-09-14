import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { isPathInside, sanitizeRoutePathSegments } from '../src/serve.mts'

describe('preview path security', () => {
  const rootPath = path.resolve('example-output')

  it('accepts the root and nested files', () => {
    expect(isPathInside(rootPath, rootPath)).toBe(true)
    expect(isPathInside(rootPath, path.join(rootPath, 'assets/app.js'))).toBe(
      true,
    )
  })

  it('rejects traversal, sibling prefixes, absolute Windows paths, and NUL', () => {
    expect(isPathInside(rootPath, path.resolve('outside.txt'))).toBe(false)
    expect(isPathInside(rootPath, `${rootPath}-backup/file.js`)).toBe(false)
    expect(isPathInside(rootPath, 'C:\\outside\\file.js')).toBe(false)
    expect(isPathInside(rootPath, path.join(rootPath, 'bad\0name'))).toBe(false)
  })

  it('rebuilds nested routes from basename-sanitized segments', () => {
    expect(sanitizeRoutePathSegments('assets/app.js')).toEqual([
      'assets',
      'app.js',
    ])
    expect(sanitizeRoutePathSegments('../outside.js')).toBeUndefined()
    expect(sanitizeRoutePathSegments('assets/bad\0name')).toBeUndefined()
  })
})
