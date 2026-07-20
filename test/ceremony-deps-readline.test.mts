/**
 * @file Readline-path coverage for createIoChannel.
 *   Lives in its own file because vi.mock('node:readline/promises')
 *   has to be hoisted to module scope; doing it inline in
 *   ceremony-deps.test.mts would mock readline for tests that need
 *   the real one. Separating gives each side a clean mock state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The mock has to live at module scope (vi.mock is hoisted), and
 * `answers` has to be reachable from inside the mock factory. Each
 * test resets the queue in beforeEach so a failing test can't
 * smuggle leftover state into the next one. */
const answers: string[] = []

vi.mock(import('node:readline/promises'), () => ({
  createInterface: () => ({
    question: async () => answers.shift() ?? '',
    close: () => {},
  }),
}))

import { createIoChannel } from '../src/ceremony-deps.mts'

beforeEach(() => {
  answers.length = 0
})

describe('createIoChannel readline fallback', () => {
  it('reads through readline when no file queue is provided', async () => {
    answers.push('  typed-share  ')
    const io = createIoChannel([])
    expect(await io.readShare('Share 1: ')).toBe('typed-share')
  })

  it('throws "share entry canceled" on empty interactive answer', async () => {
    answers.push('   ') // whitespace only → empty after trim
    const io = createIoChannel([])
    await expect(io.readShare('Share: ')).rejects.toThrow(/canceled/)
  })

  it('reuses the readline interface across multiple readShare calls', async () => {
    answers.push('share-a', 'share-b', 'share-c')
    const io = createIoChannel([])
    expect(await io.readShare('1: ')).toBe('share-a')
    expect(await io.readShare('2: ')).toBe('share-b')
    expect(await io.readShare('3: ')).toBe('share-c')
  })
})
