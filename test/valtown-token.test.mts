/**
 * @file Unit tests for Val Town token resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  missingTokenMessage,
  resolveValTownToken,
} from '../src/valtown-token.mts'

describe('resolveValTownToken', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {
      MEANDER_VALTOWN_TOKEN_ENV: process.env['MEANDER_VALTOWN_TOKEN_ENV'],
      VALTOWN_TOKEN: process.env['VALTOWN_TOKEN'],
      CUSTOM_TOKEN: process.env['CUSTOM_TOKEN'],
    }
    delete process.env['MEANDER_VALTOWN_TOKEN_ENV']
    delete process.env['VALTOWN_TOKEN']
    delete process.env['CUSTOM_TOKEN']
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  })

  it('defaults to VALTOWN_TOKEN when no override', () => {
    process.env['VALTOWN_TOKEN'] = 'vtwn_default'
    const r = resolveValTownToken()
    expect(r.envName).toBe('VALTOWN_TOKEN')
    expect(r.token).toBe('vtwn_default')
  })

  it('explicit envName arg wins over meta-var + default', () => {
    process.env['MEANDER_VALTOWN_TOKEN_ENV'] = 'CUSTOM_TOKEN'
    process.env['VALTOWN_TOKEN'] = 'vtwn_default'
    process.env['CUSTOM_TOKEN'] = 'vtwn_custom'
    const r = resolveValTownToken('CUSTOM_TOKEN')
    expect(r.envName).toBe('CUSTOM_TOKEN')
    expect(r.token).toBe('vtwn_custom')
  })

  it('MEANDER_VALTOWN_TOKEN_ENV meta-var redirects lookup', () => {
    process.env['MEANDER_VALTOWN_TOKEN_ENV'] = 'CUSTOM_TOKEN'
    process.env['CUSTOM_TOKEN'] = 'vtwn_via_meta'
    const r = resolveValTownToken()
    expect(r.envName).toBe('CUSTOM_TOKEN')
    expect(r.token).toBe('vtwn_via_meta')
  })

  it('returns null token when env var is unset', () => {
    const r = resolveValTownToken()
    expect(r.envName).toBe('VALTOWN_TOKEN')
    expect(r.token).toBeNull()
  })

  it('treats empty string as missing', () => {
    process.env['VALTOWN_TOKEN'] = ''
    const r = resolveValTownToken()
    expect(r.token).toBeNull()
  })
})

describe('missingTokenMessage', () => {
  it('mentions the env var name the caller tried', () => {
    const msg = missingTokenMessage('MY_VT')
    expect(msg).toContain('MY_VT')
    expect(msg).toContain('not found')
  })

  it('suggests both export + MEANDER_VALTOWN_TOKEN_ENV overrides', () => {
    const msg = missingTokenMessage('VALTOWN_TOKEN')
    expect(msg).toContain('export')
    expect(msg).toContain('MEANDER_VALTOWN_TOKEN_ENV')
    expect(msg).toContain('--token-env')
  })
})
