/**
 * @file Tests for resolveVal in src/valtown-env.mts.
 *   resolveVal goes through the @valtown/sdk client (not raw fetch),
 *   so its tests need the SDK mocked. Separated into its own file
 *   so the vi.mock() doesn't bleed into the fetch-based tests in
 *   test/valtown-env.test.mts.
 */

import { describe, expect, it, vi } from 'vitest'

const profileMock = vi.fn()
const aliasMock = vi.fn()

vi.mock(import('@valtown/sdk'), () => {
  /* The real export is a class — `new ValTown({...})` in production.
   * Provide a stub class whose instances expose the same shape. */
  class FakeValTown {
    me = { profile: { retrieve: profileMock } }
    alias = { username: { valName: { retrieve: aliasMock } } }
  }
  return { default: FakeValTown }
})

import { resolveVal } from '../src/valtown-env.mts'

describe('resolveVal', () => {
  it('returns the val handle with id, username, and url', async () => {
    profileMock.mockResolvedValueOnce({ username: 'alice' })
    aliasMock.mockResolvedValueOnce({
      id: 'val-id-99',
      links: { html: 'https://alice-walkthrough.web.val.run' },
    })
    const handle = await resolveVal('tok', 'walkthrough')
    expect(handle).toEqual({
      id: 'val-id-99',
      username: 'alice',
      url: 'https://alice-walkthrough.web.val.run',
    })
  })

  it('falls back to a constructed URL when links.html is absent', async () => {
    profileMock.mockResolvedValueOnce({ username: 'bob' })
    aliasMock.mockResolvedValueOnce({ id: 'val-id-100' })
    const handle = await resolveVal('tok', 'walkthrough')
    expect(handle.url).toBe('https://bob-walkthrough.web.val.run')
  })

  it('throws when the profile has no username', async () => {
    profileMock.mockResolvedValueOnce({})
    await expect(resolveVal('tok', 'walkthrough')).rejects.toThrow(
      /no username/,
    )
  })

  it('throws when the val lookup returns no id', async () => {
    profileMock.mockResolvedValueOnce({ username: 'alice' })
    aliasMock.mockResolvedValueOnce({}) // no id
    await expect(resolveVal('tok', 'missing-val')).rejects.toThrow(
      /missing-val.*not found.*alice/,
    )
  })
})
