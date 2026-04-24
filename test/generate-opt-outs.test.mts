/**
 * @fileoverview Integration tests for generate() opt-out wiring:
 * `styles: false` must skip CSS emission AND strip the <link>;
 * `theme: false` must skip theme.js inlining. These exercise
 * generate.mts end-to-end against a throwaway fixture under
 * os.tmpdir() so the test doesn't leak output into the repo.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { safeDelete } from '@socketsecurity/lib/fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generate } from '../src/generate.mts'

describe('generate opt-outs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'meander-optout-'))
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
    writeFileSync(
      path.join(tmpDir, 'src/app.ts'),
      '/* Greets the world. */\nexport function greet() { return "hi" }\n',
      'utf-8',
    )
  })

  afterEach(async () => {
    await safeDelete(tmpDir, { recursive: true, force: true })
  })

  function writeConfig(extra: Record<string, unknown>): string {
    const p = path.join(tmpDir, 'meander.config.json')
    writeFileSync(
      p,
      JSON.stringify({
        slug: 'opt-out',
        title: 'Opt-out fixture',
        parts: [
          {
            id: 1,
            title: 'One',
            objective: 'One part for the opt-out surface.',
            keywords: ['greet'],
            files: ['src/app.ts'],
          },
        ],
        ...extra,
      }),
      'utf-8',
    )
    return p
  }

  it('default config emits meander.css and links it from pages', async () => {
    await generate(writeConfig({}), { __proto__: null } as { __proto__: null })
    const pages = path.join(tmpDir, 'pages')
    expect(existsSync(path.join(pages, 'meander.css'))).toBe(true)
    const index = readFileSync(path.join(pages, 'index.html'), 'utf-8')
    expect(index).toContain('meander.css')
    expect(index).toContain('<link rel="stylesheet"')
  })

  it('`styles: false` skips meander.css emit AND drops the <link>', async () => {
    await generate(writeConfig({ styles: false }), { __proto__: null } as {
      __proto__: null
    })
    const pages = path.join(tmpDir, 'pages')
    expect(existsSync(path.join(pages, 'meander.css'))).toBe(false)
    const index = readFileSync(path.join(pages, 'index.html'), 'utf-8')
    /* No reference to meander.css anywhere in the rendered
     * page — not as a <link>, not as a preload. */
    expect(index).not.toContain('meander.css')
  })

  it('`theme: false` skips theme.js inlining', async () => {
    await generate(writeConfig({ theme: false }), { __proto__: null } as {
      __proto__: null
    })
    const index = readFileSync(
      path.join(tmpDir, 'pages', 'index.html'),
      'utf-8',
    )
    /* theme.js reads localStorage under `meander:pages:theme` —
     * a unique-enough token that only the inlined script has it.
     * Its absence signals the script was dropped. */
    expect(index).not.toContain('meander:pages:theme')
  })

  it('defaults inline theme.js', async () => {
    await generate(writeConfig({}), { __proto__: null } as { __proto__: null })
    const index = readFileSync(
      path.join(tmpDir, 'pages', 'index.html'),
      'utf-8',
    )
    expect(index).toContain('meander:pages:theme')
  })
})
