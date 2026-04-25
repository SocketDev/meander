/**
 * `meander db key` — comment-store wrapping-key ceremony.
 *
 * Subcommands:
 *   init     Generate the first wrapping key, Shamir-split it,
 *            plant MEANDER_DB_KEY_1 + MEANDER_DB_KEY_CURRENT on
 *            the val, and emit shares for distribution to
 *            custodians. Refuses if a generation already exists.
 *   rotate   Mint a new generation, re-wrap every row's DEK
 *            via /admin/rewrap, atomically flip
 *            MEANDER_DB_KEY_CURRENT to point at the new key,
 *            and emit new shares.
 *   restore  Reassemble a wrapping key from shares + plant it on
 *            the val. Used after accidental env-var loss.
 *   audit    Print which generations exist, which is current,
 *            and how many rows reference each.
 *   retire   Delete an old generation's MEANDER_DB_KEY_<n> from
 *            the val env. Refuses if any rows still reference it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

import {
  randomWrappingKey,
} from './crypto.mts'
import {
  combine,
  decodeShare,
  encodeShare,
  split,
} from './shamir.mts'
import {
  deleteEnvVar,
  getEnvVar,
  listEnvVarNames,
  resolveVal,
  setEnvVar,
  type ValHandle,
} from './valtown-env.mts'
import { missingTokenMessage, resolveValTownToken } from './valtown-token.mts'

const DB_KEY_PREFIX = 'MEANDER_DB_KEY_'
const DB_KEY_CURRENT = 'MEANDER_DB_KEY_CURRENT'
const ADMIN_TOKEN_KEY = 'MEANDER_ADMIN_TOKEN'

export type DbKeyOptions = {
  /** Override the env var read for the Val Town bearer token. */
  tokenEnv?: string | undefined
  /** Shamir threshold (min shares to reconstruct). Default: 2. */
  threshold?: number | undefined
  /** Shamir total share count. Default: 3. */
  shares?: number | undefined
  /** Files to read shares from (one share per file, base58). Read
   *  in addition to interactive prompts. */
  shareFiles?: readonly string[] | undefined
  /** Generation to operate on (retire only). */
  generation?: number | undefined
}

/* ------------------------------------------------------------------ */
/*  Shared setup                                                        */
/* ------------------------------------------------------------------ */

type Ceremony = {
  token: string
  val: ValHandle
  adminToken: string
  generations: number[]
  currentGeneration: number | undefined
}

async function loadCeremony(
  valName: string,
  tokenEnv: string | undefined,
): Promise<Ceremony> {
  const { envName, token } = resolveValTownToken(tokenEnv)
  if (!token) {
    throw new Error(missingTokenMessage(envName))
  }
  const val = await resolveVal(token, valName)
  const adminToken = await getEnvVar(token, val.id, ADMIN_TOKEN_KEY)
  if (!adminToken) {
    throw new Error(
      `${ADMIN_TOKEN_KEY} not set on val "${valName}" — run \`meander deploy-val\` first to mint it`,
    )
  }
  const names = await listEnvVarNames(token, val.id)
  const generations = names
    .filter(n => n.startsWith(DB_KEY_PREFIX) && n !== DB_KEY_CURRENT)
    .map(n => Number.parseInt(n.slice(DB_KEY_PREFIX.length), 10))
    .filter(n => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
  let currentGeneration: number | undefined
  const currentRaw = await getEnvVar(token, val.id, DB_KEY_CURRENT)
  if (currentRaw) {
    const n = Number.parseInt(currentRaw, 10)
    if (Number.isInteger(n) && n > 0) {
      currentGeneration = n
    }
  }
  return { token, val, adminToken, generations, currentGeneration }
}

/* ------------------------------------------------------------------ */
/*  Share I/O                                                          */
/* ------------------------------------------------------------------ */

/**
 * Prompt the operator for shares interactively + read any
 * `--share-file` arguments. Returns the combined list. We always
 * read `threshold` shares — the user is expected to know which
 * `threshold` they're working with (it's encoded in each share).
 */
async function gatherShares(
  threshold: number,
  shareFiles: readonly string[] | undefined,
): Promise<Uint8Array[]> {
  const shares: Uint8Array[] = []
  for (const path of shareFiles ?? []) {
    if (!existsSync(path)) {
      throw new Error(`share file not found: ${path}`)
    }
    const text = readFileSync(path, 'utf-8').trim()
    if (!text) {
      throw new Error(`share file is empty: ${path}`)
    }
    shares.push(decodeShare(text))
  }
  if (shares.length >= threshold) {
    return shares
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    while (shares.length < threshold) {
      const remaining = threshold - shares.length
      const answer = (
        await rl.question(`Share ${shares.length + 1} of ${threshold} (base58, ${remaining} remaining): `)
      ).trim()
      if (!answer) {
        throw new Error('share entry canceled')
      }
      shares.push(decodeShare(answer))
    }
  } finally {
    rl.close()
  }
  return shares
}

/**
 * Print N shares to stdout, one per line, separated by clear
 * markers. Each share is a single base58 string. The operator
 * must distribute these to N custodians before exiting.
 */
function printShares(shares: Uint8Array[]): void {
  console.log()
  console.log('═'.repeat(72))
  console.log('Shares — distribute to custodians IMMEDIATELY:')
  console.log('═'.repeat(72))
  for (let i = 0; i < shares.length; i++) {
    console.log(`Share ${i + 1} of ${shares.length}:`)
    console.log(encodeShare(shares[i]!))
    console.log()
  }
  console.log('═'.repeat(72))
  console.log(
    'These shares are the ONLY recoverable copies of the wrapping key.',
  )
  console.log(
    'Lose more than (shares - threshold) of them and the comment store is unreadable.',
  )
  console.log('═'.repeat(72))
}

function bytesToHex(bytes: Uint8Array | Buffer): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, '0')
  }
  return s
}

function hexToBytes(hex: string): Uint8Array {
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
/*  init                                                                */
/* ------------------------------------------------------------------ */

export async function dbKeyInit(
  valName: string,
  options: DbKeyOptions,
): Promise<void> {
  const threshold = options.threshold ?? 2
  const sharesCount = options.shares ?? 3
  validateShamirParams(threshold, sharesCount)

  const ceremony = await loadCeremony(valName, options.tokenEnv)
  if (ceremony.generations.length > 0) {
    throw new Error(
      `${DB_KEY_PREFIX}<n> already exists on val (generations: ${ceremony.generations.join(', ')}). Use \`meander db key rotate\` instead.`,
    )
  }

  console.log(
    `Generating wrapping key for val "${valName}" (${threshold}-of-${sharesCount} Shamir)...`,
  )
  const key = randomWrappingKey()
  const shares = split(new Uint8Array(key), threshold, sharesCount)

  await setEnvVar(
    ceremony.token,
    ceremony.val.id,
    `${DB_KEY_PREFIX}1`,
    bytesToHex(key),
  )
  console.log(`  Set ${DB_KEY_PREFIX}1`)
  await setEnvVar(ceremony.token, ceremony.val.id, DB_KEY_CURRENT, '1')
  console.log(`  Set ${DB_KEY_CURRENT}=1`)

  printShares(shares)
}

/* ------------------------------------------------------------------ */
/*  rotate                                                              */
/* ------------------------------------------------------------------ */

export async function dbKeyRotate(
  valName: string,
  options: DbKeyOptions,
): Promise<void> {
  const threshold = options.threshold ?? 2
  const sharesCount = options.shares ?? 3
  validateShamirParams(threshold, sharesCount)

  const ceremony = await loadCeremony(valName, options.tokenEnv)
  if (ceremony.currentGeneration === undefined) {
    throw new Error(
      `${DB_KEY_CURRENT} not set on val — run \`meander db key init\` first`,
    )
  }
  const fromGen = ceremony.currentGeneration
  const toGen = Math.max(...ceremony.generations) + 1

  console.log(
    `Rotating from generation ${fromGen} to ${toGen} on val "${valName}"...`,
  )
  console.log(
    `  Reconstruct generation ${fromGen} from ${threshold} shares to verify.`,
  )
  const oldShares = await gatherShares(threshold, options.shareFiles)
  const recovered = combine(oldShares)
  /* Sanity check: the reconstructed key must match the current
   * MEANDER_DB_KEY_<fromGen> on the val. If not, the operator
   * supplied bad shares — bail before changing anything. */
  const currentHex = await getEnvVar(
    ceremony.token,
    ceremony.val.id,
    `${DB_KEY_PREFIX}${fromGen}`,
  )
  if (!currentHex) {
    throw new Error(
      `${DB_KEY_PREFIX}${fromGen} not set on val — cannot verify shares`,
    )
  }
  if (bytesToHex(recovered) !== currentHex) {
    throw new Error(
      `reconstructed key does not match ${DB_KEY_PREFIX}${fromGen} — wrong shares?`,
    )
  }

  const newKey = randomWrappingKey()
  const newShares = split(new Uint8Array(newKey), threshold, sharesCount)

  /* Plant the new generation. Don't flip CURRENT yet — the val
   * needs to be able to decrypt the old generation's rows during
   * rewrap. CURRENT moves AFTER rewrap finishes. */
  await setEnvVar(
    ceremony.token,
    ceremony.val.id,
    `${DB_KEY_PREFIX}${toGen}`,
    bytesToHex(newKey),
  )
  console.log(`  Set ${DB_KEY_PREFIX}${toGen}`)

  /* Drive /admin/rewrap until the val reports remaining = 0. */
  console.log(`  Rewrapping rows from generation ${fromGen} to ${toGen}...`)
  let totalRewrapped = 0
  while (true) {
    const res = await fetch(`${ceremony.val.url}/admin/rewrap`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ceremony.adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fromGeneration: fromGen,
        toGeneration: toGen,
        batchSize: 100,
      }),
    })
    if (!res.ok) {
      throw new Error(
        `rewrap failed: ${res.status} ${await res.text()}`,
      )
    }
    const body = (await res.json()) as { rewrapped: number; remaining: number }
    totalRewrapped += body.rewrapped
    console.log(
      `    rewrapped ${body.rewrapped} this batch, ${body.remaining} remaining`,
    )
    if (body.remaining === 0) {
      break
    }
    if (body.rewrapped === 0) {
      throw new Error(
        `rewrap stalled — ${body.remaining} rows still at generation ${fromGen}`,
      )
    }
  }
  console.log(`  Rewrapped ${totalRewrapped} rows total`)

  /* Atomic flip: now point CURRENT at the new generation. New
   * writes from this point use the new key. */
  await setEnvVar(
    ceremony.token,
    ceremony.val.id,
    DB_KEY_CURRENT,
    String(toGen),
  )
  console.log(`  Set ${DB_KEY_CURRENT}=${toGen}`)

  printShares(newShares)
  console.log(
    `\nGeneration ${fromGen} remains in env; use \`meander db key retire ${fromGen}\` after backing up.`,
  )
}

/* ------------------------------------------------------------------ */
/*  restore                                                             */
/* ------------------------------------------------------------------ */

export async function dbKeyRestore(
  valName: string,
  options: DbKeyOptions,
): Promise<void> {
  const threshold = options.threshold ?? 2
  validateShamirParams(threshold, threshold)

  const ceremony = await loadCeremony(valName, options.tokenEnv)
  console.log(
    `Restoring wrapping key for val "${valName}" from ${threshold} shares...`,
  )
  const shares = await gatherShares(threshold, options.shareFiles)
  const recovered = combine(shares)
  const recoveredHex = bytesToHex(recovered)

  /* Find which generation these shares correspond to. Each
   * MEANDER_DB_KEY_<n> in env is checked — if the operator
   * supplied shares of a generation that was wiped, no match
   * means we plant a new generation slot. */
  let matchedGen: number | undefined
  for (const gen of ceremony.generations) {
    const existing = await getEnvVar(
      ceremony.token,
      ceremony.val.id,
      `${DB_KEY_PREFIX}${gen}`,
    )
    if (existing === recoveredHex) {
      matchedGen = gen
      break
    }
  }

  if (matchedGen !== undefined) {
    console.log(
      `  Shares match existing ${DB_KEY_PREFIX}${matchedGen} — nothing to restore`,
    )
    return
  }

  /* No match. The most likely scenario: env was wiped and we're
   * planting back. Use the lowest-numbered missing generation
   * (typically 1 if everything is gone). */
  const planTarget = ceremony.generations.length > 0
    ? Math.max(...ceremony.generations) + 1
    : 1
  await setEnvVar(
    ceremony.token,
    ceremony.val.id,
    `${DB_KEY_PREFIX}${planTarget}`,
    recoveredHex,
  )
  console.log(`  Set ${DB_KEY_PREFIX}${planTarget}`)
  if (ceremony.currentGeneration === undefined) {
    await setEnvVar(
      ceremony.token,
      ceremony.val.id,
      DB_KEY_CURRENT,
      String(planTarget),
    )
    console.log(`  Set ${DB_KEY_CURRENT}=${planTarget}`)
  }
}

/* ------------------------------------------------------------------ */
/*  audit                                                               */
/* ------------------------------------------------------------------ */

export async function dbKeyAudit(
  valName: string,
  options: DbKeyOptions,
): Promise<void> {
  const ceremony = await loadCeremony(valName, options.tokenEnv)
  const res = await fetch(`${ceremony.val.url}/admin/key-audit`, {
    headers: { Authorization: `Bearer ${ceremony.adminToken}` },
  })
  if (!res.ok) {
    throw new Error(`audit failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as {
    visibleGenerations: number[]
    currentGeneration: number
    rowCounts: Record<string, number>
  }
  console.log(`Val: ${valName} (${ceremony.val.url})`)
  console.log(`Visible generations: ${body.visibleGenerations.join(', ')}`)
  console.log(`Current (used for new writes): ${body.currentGeneration}`)
  console.log('Row counts by generation:')
  const sortedGens = Object.keys(body.rowCounts)
    .map(Number)
    .sort((a, b) => a - b)
  if (sortedGens.length === 0) {
    console.log('  (no comments)')
  }
  for (const gen of sortedGens) {
    const n = body.rowCounts[String(gen)]!
    const marker =
      gen === body.currentGeneration ? ' ← current' : ''
    console.log(`  generation ${gen}: ${n} row(s)${marker}`)
  }
  /* Also surface generations in env that don't appear in counts —
   * those are decommissionable via retire. */
  for (const gen of body.visibleGenerations) {
    if (
      gen !== body.currentGeneration &&
      !(String(gen) in body.rowCounts)
    ) {
      console.log(
        `  generation ${gen}: 0 rows — eligible for \`meander db key retire ${gen}\``,
      )
    }
  }
}

/* ------------------------------------------------------------------ */
/*  retire                                                              */
/* ------------------------------------------------------------------ */

export async function dbKeyRetire(
  valName: string,
  options: DbKeyOptions,
): Promise<void> {
  const target = options.generation
  if (target === undefined || !Number.isInteger(target) || target <= 0) {
    throw new Error('--generation <n> required (positive integer)')
  }
  const ceremony = await loadCeremony(valName, options.tokenEnv)
  if (target === ceremony.currentGeneration) {
    throw new Error(
      `cannot retire generation ${target} — it is the current generation`,
    )
  }
  if (!ceremony.generations.includes(target)) {
    throw new Error(
      `generation ${target} is not present in env (visible: ${ceremony.generations.join(', ')})`,
    )
  }

  /* Pre-flight: refuse if any rows still reference target. */
  const auditRes = await fetch(`${ceremony.val.url}/admin/key-audit`, {
    headers: { Authorization: `Bearer ${ceremony.adminToken}` },
  })
  if (!auditRes.ok) {
    throw new Error(
      `pre-flight audit failed: ${auditRes.status} ${await auditRes.text()}`,
    )
  }
  const audit = (await auditRes.json()) as {
    rowCounts: Record<string, number>
  }
  const stillReferenced = audit.rowCounts[String(target)] ?? 0
  if (stillReferenced > 0) {
    throw new Error(
      `${stillReferenced} row(s) still reference generation ${target} — run \`meander db key rotate\` first to migrate them off`,
    )
  }

  const removed = await deleteEnvVar(
    ceremony.token,
    ceremony.val.id,
    `${DB_KEY_PREFIX}${target}`,
  )
  if (!removed) {
    console.log(
      `  ${DB_KEY_PREFIX}${target} was not present (nothing to remove)`,
    )
    return
  }
  console.log(`  Removed ${DB_KEY_PREFIX}${target}`)
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function validateShamirParams(threshold: number, shares: number): void {
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

/* Internal export for testing — needs to be exported so test files
 * can exercise the helpers without mocking the entire ceremony. */
export const __test = {
  bytesToHex,
  hexToBytes,
  validateShamirParams,
}
