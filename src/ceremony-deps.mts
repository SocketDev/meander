/**
 * Dependency-injection seam for `meander db key` and
 * `meander blob key` ceremonies.
 *
 * The ceremony commands are pure orchestration over four side
 * effects: HTTP calls to Val Town's REST API, /admin/* calls to
 * the deployed val, interactive stdin (share entry), and printed
 * output (shares + status messages). We bundle those into a
 * `CeremonyDeps` struct that ceremonies accept as a parameter.
 *
 * In production: `createDefaultDeps(token, val)` returns a
 * struct backed by real fetch / readline / console / crypto.
 *
 * In tests: handcraft the struct with in-memory fakes — no
 * network, no stdin, no real entropy. See test/db-key-ceremony.test.mts
 * for the pattern.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

import { randomWrappingKey as realRandomWrappingKey } from './crypto.mts'
import { decodeShare, encodeShare } from './shamir.mts'
import {
  deleteEnvVar as realDeleteEnvVar,
  getEnvVar as realGetEnvVar,
  listEnvVarNames as realListEnvVarNames,
  setEnvVar as realSetEnvVar,
  type ValHandle,
} from './valtown-env.mts'

/**
 * Bound Val Town env-var client. Each method is the same as the
 * free function in `valtown-env.mts` with `token` + `valId` already
 * baked in — keeps ceremony call sites tidy and gives tests a
 * single object to fake.
 */
export type EnvClient = {
  getEnvVar: (key: string) => Promise<string | undefined>
  setEnvVar: (key: string, value: string) => Promise<void>
  deleteEnvVar: (key: string) => Promise<boolean>
  listEnvVarNames: () => Promise<string[]>
}

/**
 * Bound admin-route client for the deployed val. Wraps the
 * MEANDER_ADMIN_TOKEN-authenticated `/admin/*` endpoints. Tests
 * pass a fake that simulates the val's responses without
 * needing a live val.
 */
export type AdminClient = {
  keyAudit: () => Promise<KeyAuditResponse>
  rewrap: (req: RewrapRequest) => Promise<RewrapResponse>
}

export type KeyAuditResponse = {
  visibleGenerations: number[]
  currentGeneration: number
  rowCounts: Record<string, number>
}

export type RewrapRequest = {
  fromGeneration: number
  toGeneration: number
  batchSize?: number | undefined
}

export type RewrapResponse = {
  rewrapped: number
  remaining: number
}

/**
 * I/O channel for share entry + ceremony output. `readShare`
 * pulls one share string from stdin (interactive) or from a
 * file path (`--share-file`). `printLine` is the
 * status-message sink — production writes to stdout, tests
 * collect into an array.
 */
export type IoChannel = {
  /**
   * Read a base58-encoded share. `prompt` is the message
   * shown to the operator (interactive runs); ignored when
   * the next available share comes from `shareFiles`.
   */
  readShare: (prompt: string) => Promise<string>
  /** Write a status line. Tests assert on the captured array. */
  printLine: (line: string) => void
}

export type CeremonyDeps = {
  /** Bound env-var client targeting the val. */
  env: EnvClient
  /** Bound admin-route client targeting the val. */
  admin: AdminClient
  /** Interactive + file-driven share entry, plus output sink. */
  io: IoChannel
  /** Random 32-byte wrapping key. Tests substitute a deterministic
   *  function for reproducible fixtures. */
  randomWrappingKey: () => Buffer
}

/* ------------------------------------------------------------------ */
/*  Production factories                                                */
/* ------------------------------------------------------------------ */

/** Build the production EnvClient bound to a token + val. */
export function createEnvClient(token: string, valId: string): EnvClient {
  return {
    getEnvVar: key => realGetEnvVar(token, valId, key),
    setEnvVar: (key, value) => realSetEnvVar(token, valId, key, value),
    deleteEnvVar: key => realDeleteEnvVar(token, valId, key),
    listEnvVarNames: () => realListEnvVarNames(token, valId),
  }
}

/**
 * Build the production AdminClient targeting the val. Uses the
 * Val's own URL + a previously-fetched MEANDER_ADMIN_TOKEN to call
 * /admin/* endpoints. Errors propagate as Error so the ceremony's
 * top-level handler can format them.
 */
export function createAdminClient(
  valUrl: string,
  adminToken: string,
): AdminClient {
  return {
    async keyAudit() {
      const res = await fetch(`${valUrl}/admin/key-audit`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      if (!res.ok) {
        throw new Error(`audit failed: ${res.status} ${await res.text()}`)
      }
      return (await res.json()) as KeyAuditResponse
    },
    async rewrap(req) {
      const res = await fetch(`${valUrl}/admin/rewrap`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fromGeneration: req.fromGeneration,
          toGeneration: req.toGeneration,
          batchSize: req.batchSize ?? 100,
        }),
      })
      if (!res.ok) {
        throw new Error(`rewrap failed: ${res.status} ${await res.text()}`)
      }
      return (await res.json()) as RewrapResponse
    },
  }
}

/**
 * Build the production IoChannel. `shareFiles` pre-loads share
 * strings from `--share-file` flags; readShare pops from that
 * queue first, then falls through to interactive readline once
 * the queue empties.
 */
export function createIoChannel(
  shareFiles: readonly string[] = [],
): IoChannel {
  const queue: string[] = []
  for (const path of shareFiles) {
    if (!existsSync(path)) {
      throw new Error(`share file not found: ${path}`)
    }
    const text = readFileSync(path, 'utf-8').trim()
    if (!text) {
      throw new Error(`share file is empty: ${path}`)
    }
    queue.push(text)
  }
  let rl: ReturnType<typeof createInterface> | undefined
  const ensureRl = () => {
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stderr })
    }
    return rl
  }
  return {
    async readShare(prompt: string): Promise<string> {
      const queued = queue.shift()
      if (queued !== undefined) {
        return queued
      }
      const answer = (await ensureRl().question(prompt)).trim()
      if (!answer) {
        throw new Error('share entry canceled')
      }
      return answer
    },
    printLine(line: string) {
      console.log(line)
    },
  }
}

/**
 * Bundle the full production CeremonyDeps. Convenience builder
 * for `cli.mts`'s dispatch — keeps the call sites short.
 */
export function createDefaultDeps(
  token: string,
  val: ValHandle,
  adminToken: string,
  shareFiles: readonly string[] = [],
): CeremonyDeps {
  return {
    env: createEnvClient(token, val.id),
    admin: createAdminClient(val.url, adminToken),
    io: createIoChannel(shareFiles),
    randomWrappingKey: realRandomWrappingKey,
  }
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (used by ceremonies, side-effect-free)                */
/* ------------------------------------------------------------------ */

/**
 * Pull `threshold` shares through the IoChannel and decode each
 * from base58 to raw bytes. The channel decides whether each
 * share comes from a file or an interactive prompt.
 */
export async function gatherShares(
  io: IoChannel,
  threshold: number,
): Promise<Uint8Array[]> {
  const shares: Uint8Array[] = []
  while (shares.length < threshold) {
    const remaining = threshold - shares.length
    const prompt = `Share ${shares.length + 1} of ${threshold} (base58, ${remaining} remaining): `
    const text = await io.readShare(prompt)
    shares.push(decodeShare(text))
  }
  return shares
}

/**
 * Print a block of shares to the IoChannel with prominent
 * separators + the standard custodian-warning footer. The
 * `dataKindForFooter` toggles the second sentence between the
 * comment-store wording ("comment store is unreadable") and the
 * blob wording ("encrypted blobs are unreadable"). All output
 * routes through `io.printLine` so tests can assert on it.
 */
export function printShares(
  io: IoChannel,
  shares: Uint8Array[],
  threshold: number,
  dataKindForFooter: 'comment-store' | 'blobs',
): void {
  io.printLine('')
  io.printLine('═'.repeat(72))
  io.printLine('Shares — distribute to custodians IMMEDIATELY:')
  io.printLine('═'.repeat(72))
  for (let i = 0; i < shares.length; i++) {
    io.printLine(`Share ${i + 1} of ${shares.length}:`)
    io.printLine(encodeShare(shares[i]!))
    io.printLine('')
  }
  io.printLine('═'.repeat(72))
  io.printLine(
    'These shares are the ONLY recoverable copies of the wrapping key.',
  )
  if (dataKindForFooter === 'comment-store') {
    io.printLine(
      `Lose more than (shares - ${threshold}) of them and the comment store is unreadable.`,
    )
  } else {
    io.printLine(
      `Lose more than (shares - ${threshold}) of them and existing encrypted blobs`,
    )
    io.printLine(
      'are unreadable. (Re-publishing all blobs under a fresh key recovers.)',
    )
  }
  io.printLine('═'.repeat(72))
}

/* ------------------------------------------------------------------ */
/*  Hex coding (small enough to live here vs. a shared utility)        */
/* ------------------------------------------------------------------ */

export function bytesToHex(bytes: Uint8Array | Buffer): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0')
  }
  return s
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('expected 64 hex characters (32 bytes)')
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  Param validation                                                    */
/* ------------------------------------------------------------------ */

export function validateShamirParams(threshold: number, shares: number): void {
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new Error('--threshold must be an integer >= 2')
  }
  if (!Number.isInteger(shares) || shares < threshold) {
    throw new Error('--shares must be an integer >= threshold')
  }
  if (shares > 255) {
    throw new Error('--shares must be <= 255 (Shamir GF(2^8) limit)')
  }
}
