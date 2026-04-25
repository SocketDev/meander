/**
 * `meander blob key` — walkthrough-blob wrapping-key ceremony.
 *
 * Subcommands:
 *   init     Generate the wrapping key, Shamir-split it, plant
 *            MEANDER_BLOB_KEY on the val, and print shares for
 *            distribution. Refuses if a key already exists.
 *   rotate   Generate a new key, plant it on the val, print
 *            new shares. Operator runs `meander publish` after
 *            rotation to re-encrypt every blob under the new
 *            key — blobs are regenerable from source, so there's
 *            no rewrap dance.
 *   restore  Reassemble the key from shares + plant it on the
 *            val. Used after accidental env-var loss.
 *   show     Print the current MEANDER_BLOB_KEY's hex form.
 *            Used to seed the operator's local env so
 *            `meander publish` can encrypt blobs.
 *
 * Asymmetric to `db key` because blob storage is regenerable:
 *   - No generation pointer, no per-blob generation tag.
 *   - No /admin/rewrap endpoint — old blobs become un-decryptable
 *     after rotation, but `meander publish` rebuilds them.
 *   - The operator holds a copy locally (publish needs it).
 *
 * Same Shamir machinery + same operator-side share UX as `db key`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

import { randomWrappingKey } from './crypto.mts'
import { combine, decodeShare, encodeShare, split } from './shamir.mts'
import {
  getEnvVar,
  resolveVal,
  setEnvVar,
  type ValHandle,
} from './valtown-env.mts'
import { missingTokenMessage, resolveValTownToken } from './valtown-token.mts'

const BLOB_KEY = 'MEANDER_BLOB_KEY'

export type BlobKeyOptions = {
  tokenEnv?: string | undefined
  threshold?: number | undefined
  shares?: number | undefined
  shareFiles?: readonly string[] | undefined
}

type Ceremony = {
  token: string
  val: ValHandle
  existing: string | undefined
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
  const existing = await getEnvVar(token, val.id, BLOB_KEY)
  return { token, val, existing }
}

/* ------------------------------------------------------------------ */
/*  Share I/O                                                          */
/* ------------------------------------------------------------------ */

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
    'Lose more than (shares - threshold) of them and existing encrypted blobs',
  )
  console.log(
    'are unreadable. (Re-publishing all blobs under a fresh key recovers.)',
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

/* ------------------------------------------------------------------ */
/*  init                                                                */
/* ------------------------------------------------------------------ */

export async function blobKeyInit(
  valName: string,
  options: BlobKeyOptions,
): Promise<void> {
  const threshold = options.threshold ?? 2
  const sharesCount = options.shares ?? 3
  validateShamirParams(threshold, sharesCount)

  const ceremony = await loadCeremony(valName, options.tokenEnv)
  if (ceremony.existing) {
    throw new Error(
      `${BLOB_KEY} already set on val. Use \`meander blob key rotate\` to mint a new one (and re-publish).`,
    )
  }

  console.log(
    `Generating blob wrapping key for val "${valName}" (${threshold}-of-${sharesCount} Shamir)...`,
  )
  const key = randomWrappingKey()
  const shares = split(new Uint8Array(key), threshold, sharesCount)
  const hex = bytesToHex(key)

  await setEnvVar(ceremony.token, ceremony.val.id, BLOB_KEY, hex)
  console.log(`  Set ${BLOB_KEY}`)

  printShares(shares)
  console.log()
  console.log('Local env: set the same key in your shell so `meander publish`')
  console.log('can encrypt blobs (encryptBlobs: true in meander.config.json):')
  console.log()
  console.log(`  export ${BLOB_KEY}=${hex}`)
}

/* ------------------------------------------------------------------ */
/*  rotate                                                              */
/* ------------------------------------------------------------------ */

export async function blobKeyRotate(
  valName: string,
  options: BlobKeyOptions,
): Promise<void> {
  const threshold = options.threshold ?? 2
  const sharesCount = options.shares ?? 3
  validateShamirParams(threshold, sharesCount)

  const ceremony = await loadCeremony(valName, options.tokenEnv)
  if (!ceremony.existing) {
    throw new Error(
      `${BLOB_KEY} not set on val — run \`meander blob key init\` first`,
    )
  }

  console.log(`Rotating ${BLOB_KEY} on val "${valName}"...`)
  console.log(
    `  Reconstruct current key from ${threshold} shares to verify.`,
  )
  const oldShares = await gatherShares(threshold, options.shareFiles)
  const recovered = combine(oldShares)
  if (bytesToHex(recovered) !== ceremony.existing) {
    throw new Error(
      `reconstructed key does not match ${BLOB_KEY} on val — wrong shares?`,
    )
  }

  const newKey = randomWrappingKey()
  const newShares = split(new Uint8Array(newKey), threshold, sharesCount)
  const hex = bytesToHex(newKey)

  await setEnvVar(ceremony.token, ceremony.val.id, BLOB_KEY, hex)
  console.log(`  Set ${BLOB_KEY}`)

  printShares(newShares)
  console.log()
  console.log('Local env: replace your shell\'s key value, then re-publish:')
  console.log()
  console.log(`  export ${BLOB_KEY}=${hex}`)
  console.log(`  meander publish meander.config.json`)
  console.log()
  console.log(
    'Until you re-publish, every existing encrypted blob is unreadable',
  )
  console.log(
    `(the val's MEANDER_BLOB_KEY no longer matches the wrapped DEKs in storage).`,
  )
}

/* ------------------------------------------------------------------ */
/*  restore                                                             */
/* ------------------------------------------------------------------ */

export async function blobKeyRestore(
  valName: string,
  options: BlobKeyOptions,
): Promise<void> {
  const threshold = options.threshold ?? 2
  validateShamirParams(threshold, threshold)

  const ceremony = await loadCeremony(valName, options.tokenEnv)
  console.log(
    `Restoring ${BLOB_KEY} for val "${valName}" from ${threshold} shares...`,
  )
  const shares = await gatherShares(threshold, options.shareFiles)
  const recovered = combine(shares)
  const hex = bytesToHex(recovered)

  if (ceremony.existing === hex) {
    console.log(`  Shares match existing ${BLOB_KEY} — nothing to restore`)
    return
  }
  if (ceremony.existing) {
    throw new Error(
      `${BLOB_KEY} is already set to a different value. Use \`meander blob key rotate\` to replace it.`,
    )
  }

  await setEnvVar(ceremony.token, ceremony.val.id, BLOB_KEY, hex)
  console.log(`  Set ${BLOB_KEY}`)
  console.log()
  console.log(
    'Local env: set the same key in your shell so `meander publish` works:',
  )
  console.log()
  console.log(`  export ${BLOB_KEY}=${hex}`)
}

/* ------------------------------------------------------------------ */
/*  show                                                                */
/* ------------------------------------------------------------------ */

/**
 * Print the val's current MEANDER_BLOB_KEY in hex. Lets the
 * operator re-seed their local env after a fresh checkout without
 * re-running the ceremony — `meander publish` needs the same key
 * the val holds, and rebuilding it from shares every time is
 * unnecessary friction when the operator already has VALTOWN_TOKEN.
 *
 * NB: this command consciously echoes a wrapping key to stdout.
 * It's the sole interactive way to bootstrap a new operator's
 * laptop; pipe it into the operator's password manager rather
 * than letting it sit in shell history.
 */
export async function blobKeyShow(
  valName: string,
  options: BlobKeyOptions,
): Promise<void> {
  const ceremony = await loadCeremony(valName, options.tokenEnv)
  if (!ceremony.existing) {
    throw new Error(
      `${BLOB_KEY} not set on val "${valName}" — run \`meander blob key init\` first`,
    )
  }
  /* Print only — no labels — so callers can pipe into pbcopy/etc.
   * `meander blob key show <name> | pbcopy` works without trimming. */
  process.stdout.write(`${ceremony.existing}\n`)
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

export const __test = {
  bytesToHex,
  validateShamirParams,
}
