/**
 * Wrapping-key resolution for the val.
 *
 * The val sees env vars of the form `MEANDER_DB_KEY_<n>` (one per
 * generation, hex-encoded 32-byte keys) plus `MEANDER_DB_KEY_CURRENT`
 * (the integer generation to use for *new* writes). Old generations
 * stay live as long as any row still references them, so reads can
 * unwrap rows wrapped under any past generation.
 *
 * For walkthrough blobs there's only one key (`MEANDER_BLOB_KEY`).
 * Blob rotation = republish, so generation coexistence has no value
 * on the val side — a single env var suffices.
 *
 * Imported CryptoKeys are cached forever per process: they never
 * change for a given env-var value, and the val process is short
 * enough that memory is not a concern.
 */

import { decodeHexKey, importKey } from './crypto.ts'

export type WrappingKeyContext = {
  /**
   * Generation pointer for new writes — e.g. 2 means new comments
   * wrap their DEK with MEANDER_DB_KEY_2.
   */
  currentGeneration: number
  /**
   * Look up + import the wrapping CryptoKey for any past generation,
   * or throw if it's not present in env. Used by readers that need
   * to unwrap rows wrapped under a non-current generation.
   */
  getKey: (generation: number) => Promise<CryptoKey>
  /**
   * Convenience: the current generation's wrapping key.
   */
  getCurrentKey: () => Promise<CryptoKey>
  /**
   * All generation numbers visible in the env, sorted ascending.
   * Used by /admin endpoints that audit / iterate generations.
   */
  visibleGenerations: () => number[]
}

const DB_KEY_PREFIX = 'MEANDER_DB_KEY_'
const DB_KEY_CURRENT = 'MEANDER_DB_KEY_CURRENT'
const BLOB_KEY_VAR = 'MEANDER_BLOB_KEY'

/* Blob-key cache. The sentinel symbol distinguishes "first call,
 * not yet computed" from "computed, result was undefined" — which a
 * plain undefined-valued slot can't. */
const NOT_LOADED = Symbol('blob-key-not-loaded')
let blobKeyCache: Promise<CryptoKey> | undefined | typeof NOT_LOADED =
  NOT_LOADED

/* List integer generations from MEANDER_DB_KEY_<n> env vars. */
export function listGenerations(): number[] {
  const out: number[] = []
  /* Deno exposes Deno.env.toObject() — the val runs on Deno so this
   * is the right shape. */
  const env = Deno.env.toObject()
  const names = Object.keys(env)
  for (let i = 0, { length } = names; i < length; i += 1) {
    const name = names[i]
    if (!name.startsWith(DB_KEY_PREFIX)) {
      continue
    }
    if (name === DB_KEY_CURRENT) {
      continue
    }
    const tail = name.slice(DB_KEY_PREFIX.length)
    const n = Number.parseInt(tail, 10)
    if (Number.isInteger(n) && String(n) === tail && n > 0) {
      out.push(n)
    }
  }
  out.sort((a, b) => a - b)
  return out
}

/**
 * Load the single blob wrapping key, or undefined if blob
 * encryption is not enabled on this val. Cached after first call.
 *
 * The cache uses a sentinel symbol to distinguish "first call,
 * not yet computed" from "computed, result was undefined" — which
 * a plain undefined-valued slot can't.
 */
export function loadBlobKey(): Promise<CryptoKey> | undefined {
  if (blobKeyCache !== NOT_LOADED) {
    return blobKeyCache
  }
  const hex = Deno.env.get(BLOB_KEY_VAR)
  if (!hex) {
    blobKeyCache = undefined
    return undefined
  }
  blobKeyCache = importKey(decodeHexKey(hex))
  return blobKeyCache
}

/**
 * Build a wrapping-key context from the val's env. Returns
 * undefined if no MEANDER_DB_KEY_* generations are configured —
 * callers treat this as "comment writes disabled until ops runs
 * `meander db key init`".
 */
export function loadDbKeyContext(): WrappingKeyContext | undefined {
  const generations = listGenerations()
  if (generations.length === 0) {
    return undefined
  }
  const currentRaw = Deno.env.get(DB_KEY_CURRENT)
  const current = currentRaw ? Number.parseInt(currentRaw, 10) : NaN
  if (!Number.isInteger(current) || !generations.includes(current)) {
    throw new Error(
      `${DB_KEY_CURRENT} must be set to one of: ${generations.join(', ')} (got ${currentRaw ?? '<unset>'})`,
    )
  }
  /* Cache imported CryptoKeys by generation. */
  const cache = new Map<number, Promise<CryptoKey>>()
  const getKey = (gen: number): Promise<CryptoKey> => {
    let p = cache.get(gen)
    if (p) {
      return p
    }
    const hex = Deno.env.get(`${DB_KEY_PREFIX}${gen}`)
    if (!hex) {
      throw new Error(`${DB_KEY_PREFIX}${gen} is not set in env`)
    }
    p = importKey(decodeHexKey(hex))
    cache.set(gen, p)
    return p
  }
  return {
    currentGeneration: current,
    getKey,
    getCurrentKey: () => getKey(current),
    visibleGenerations: () => generations.slice(),
  }
}
