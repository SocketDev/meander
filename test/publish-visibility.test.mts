/**
 * @file Covers the order `meander publish` writes the walkthrough-visibility
 *   record in, which is the whole of its correctness.
 *   Publishing encrypted must mark the slug private BEFORE the first blob goes
 *   up; publishing plaintext must settle the record only AFTER the last one.
 *   Either way the recorded flag is the more restrictive of the old and new
 *   states for the whole of the transition, so there is no instant at which
 *   the val serves a private walkthrough's comments to an anonymous caller.
 *   `nock` intercepts at the http/https layer, so the assertions are on the
 *   real request sequence the module emits. No live network, no Val Town
 *   account, and the fixture walkthrough is written to a tmpdir.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import nock from 'nock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { publish } from '../src/publish.mts'
import { API_BASE } from '../src/val-visibility.mts'

const BLOB_KEY_HEX = 'a'.repeat(64)

let workDir: string
let savedToken: string | undefined
let savedBlobKey: string | undefined

/**
 * A minimal published walkthrough on disk: the config plus every
 * file `publish` reads out of the out-dir.
 */
function writeWalkthrough(encryptBlobs: boolean): string {
  const outDir = path.join(workDir, 'pages')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'meander.css'), 'body{}')
  writeFileSync(path.join(outDir, 'index.html'), '<html>index</html>')
  writeFileSync(path.join(outDir, 'part-1.html'), '<html>part</html>')
  writeFileSync(path.join(outDir, 'manifest.json'), '{}')
  const configPath = path.join(workDir, 'meander.config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ slug: 'alpha', parts: [{ id: 1 }], encryptBlobs }),
  )
  return configPath
}

/**
 * Intercept every call `publish` makes and return them in order.
 * A blob upload records as `blob:<key>`, a visibility write as
 * `visibility:private` or `visibility:public`.
 */
function recordCalls(): string[] {
  const calls: string[] = []
  nock(API_BASE)
    .persist()
    .post(/^\/v1\/blob\//)
    .reply(function () {
      calls.push(
        `blob:${decodeURIComponent(this.req.path.slice('/v1/blob/'.length))}`,
      )
      return [200, '']
    })
  nock(API_BASE)
    .persist()
    .post('/v1/sqlite/batch', body => {
      const statements = (body as { statements: unknown[] }).statements
      const upsert = statements[1] as { args: unknown[] }
      calls.push(`visibility:${upsert.args[1] === 1 ? 'private' : 'public'}`)
      return true
    })
    .reply(200, [])
  return calls
}

beforeEach(() => {
  nock.disableNetConnect()
  workDir = mkdtempSync(path.join(os.tmpdir(), 'meander-publish-'))
  savedToken = process.env['VALTOWN_TOKEN']
  savedBlobKey = process.env['MEANDER_BLOB_KEY']
  process.env['VALTOWN_TOKEN'] = 'tok'
  process.env['MEANDER_BLOB_KEY'] = BLOB_KEY_HEX
})

afterEach(async () => {
  nock.cleanAll()
  nock.enableNetConnect()
  await safeDelete(workDir, { recursive: true, force: true })
  if (savedToken === undefined) {
    delete process.env['VALTOWN_TOKEN']
  } else {
    process.env['VALTOWN_TOKEN'] = savedToken
  }
  if (savedBlobKey === undefined) {
    delete process.env['MEANDER_BLOB_KEY']
  } else {
    process.env['MEANDER_BLOB_KEY'] = savedBlobKey
  }
})

describe('publishing an encrypted walkthrough', () => {
  it('marks the slug private before the first blob goes up', async () => {
    const calls = recordCalls()
    await publish(writeWalkthrough(true))
    expect(calls[0]).toBe('visibility:private')
    expect(calls.indexOf('visibility:private')).toBeLessThan(
      calls.findIndex(call => call.startsWith('blob:')),
    )
  })

  it('confirms the slug private after the last blob', async () => {
    const calls = recordCalls()
    await publish(writeWalkthrough(true))
    expect(calls.at(-1)).toBe('visibility:private')
  })

  it('never records the walkthrough as public', async () => {
    const calls = recordCalls()
    await publish(writeWalkthrough(true))
    expect(calls).not.toContain('visibility:public')
  })

  it('uploads envelope-sealed pages', async () => {
    const bodies: string[] = []
    nock(API_BASE)
      .persist()
      .post(/^\/v1\/blob\//, body => {
        bodies.push(String(body))
        return true
      })
      .reply(200, '')
    nock(API_BASE).persist().post('/v1/sqlite/batch').reply(200, [])
    await publish(writeWalkthrough(true))
    expect(bodies.some(body => body.startsWith('ENVELOPE:'))).toBe(true)
  })
})

describe('publishing a plaintext walkthrough', () => {
  it('settles the record only after every blob is up', async () => {
    const calls = recordCalls()
    await publish(writeWalkthrough(false))
    expect(calls.at(-1)).toBe('visibility:public')
    expect(calls.filter(call => call.startsWith('visibility:'))).toEqual([
      'visibility:public',
    ])
  })

  it('leaves an earlier private record standing until then', async () => {
    const calls = recordCalls()
    await publish(writeWalkthrough(false))
    const firstBlob = calls.findIndex(call => call.startsWith('blob:'))
    expect(firstBlob).toBe(0)
  })
})

describe('a visibility write that fails', () => {
  it('aborts the publish rather than reporting success', async () => {
    nock(API_BASE)
      .persist()
      .post(/^\/v1\/blob\//)
      .reply(200, '')
    nock(API_BASE).persist().post('/v1/sqlite/batch').reply(403, 'forbidden')
    await expect(publish(writeWalkthrough(true))).rejects.toThrow(
      /Failed to record walkthrough "alpha" as private/,
    )
  })
})
