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
 */

import { combine, split } from './shamir.mts'
import {
  bytesToHex,
  gatherShares,
  printShares,
  validateShamirParams,
  type CeremonyDeps,
} from './ceremony-deps.mts'

const BLOB_KEY = 'MEANDER_BLOB_KEY'

export type BlobKeyOptions = {
  threshold?: number | undefined
  shares?: number | undefined
}

/* ------------------------------------------------------------------ */
/*  init                                                                */
/* ------------------------------------------------------------------ */

export async function blobKeyInit(
  options: BlobKeyOptions,
  deps: CeremonyDeps,
): Promise<void> {
  const threshold = options.threshold ?? 2
  const sharesCount = options.shares ?? 3
  validateShamirParams(threshold, sharesCount)

  const existing = await deps.env.getEnvVar(BLOB_KEY)
  if (existing) {
    throw new Error(
      `${BLOB_KEY} already set on val. Use \`meander blob key rotate\` to mint a new one (and re-publish).`,
    )
  }

  deps.io.printLine(
    `Generating blob wrapping key (${threshold}-of-${sharesCount} Shamir)...`,
  )
  const key = deps.randomWrappingKey()
  const shares = split(new Uint8Array(key), threshold, sharesCount)
  const hex = bytesToHex(key)

  await deps.env.setEnvVar(BLOB_KEY, hex)
  deps.io.printLine(`  Set ${BLOB_KEY}`)

  printShares(deps.io, shares, threshold, 'blobs')
  deps.io.printLine('')
  deps.io.printLine(
    'Local env: set the same key in your shell so `meander publish`',
  )
  deps.io.printLine(
    'can encrypt blobs (encryptBlobs: true in meander.config.json):',
  )
  deps.io.printLine('')
  deps.io.printLine(`  export ${BLOB_KEY}=${hex}`)
}

/* ------------------------------------------------------------------ */
/*  rotate                                                              */
/* ------------------------------------------------------------------ */

export async function blobKeyRotate(
  options: BlobKeyOptions,
  deps: CeremonyDeps,
): Promise<void> {
  const threshold = options.threshold ?? 2
  const sharesCount = options.shares ?? 3
  validateShamirParams(threshold, sharesCount)

  const existing = await deps.env.getEnvVar(BLOB_KEY)
  if (!existing) {
    throw new Error(
      `${BLOB_KEY} not set on val — run \`meander blob key init\` first`,
    )
  }

  deps.io.printLine(`Rotating ${BLOB_KEY}...`)
  deps.io.printLine(
    `  Reconstruct current key from ${threshold} shares to verify.`,
  )
  const oldShares = await gatherShares(deps.io, threshold)
  const recovered = combine(oldShares)
  if (bytesToHex(recovered) !== existing) {
    throw new Error(
      `reconstructed key does not match ${BLOB_KEY} on val — wrong shares?`,
    )
  }

  const newKey = deps.randomWrappingKey()
  const newShares = split(new Uint8Array(newKey), threshold, sharesCount)
  const hex = bytesToHex(newKey)

  await deps.env.setEnvVar(BLOB_KEY, hex)
  deps.io.printLine(`  Set ${BLOB_KEY}`)

  printShares(deps.io, newShares, threshold, 'blobs')
  deps.io.printLine('')
  deps.io.printLine(
    "Local env: replace your shell's key value, then re-publish:",
  )
  deps.io.printLine('')
  deps.io.printLine(`  export ${BLOB_KEY}=${hex}`)
  deps.io.printLine(`  meander publish meander.config.json`)
  deps.io.printLine('')
  deps.io.printLine(
    'Until you re-publish, every existing encrypted blob is unreadable',
  )
  deps.io.printLine(
    `(the val's MEANDER_BLOB_KEY no longer matches the wrapped DEKs in storage).`,
  )
}

/* ------------------------------------------------------------------ */
/*  restore                                                             */
/* ------------------------------------------------------------------ */

export async function blobKeyRestore(
  options: BlobKeyOptions,
  deps: CeremonyDeps,
): Promise<void> {
  const threshold = options.threshold ?? 2
  validateShamirParams(threshold, threshold)

  const existing = await deps.env.getEnvVar(BLOB_KEY)
  deps.io.printLine(`Restoring ${BLOB_KEY} from ${threshold} shares...`)
  const shares = await gatherShares(deps.io, threshold)
  const recovered = combine(shares)
  const hex = bytesToHex(recovered)

  if (existing === hex) {
    deps.io.printLine(
      `  Shares match existing ${BLOB_KEY} — nothing to restore`,
    )
    return
  }
  if (existing) {
    throw new Error(
      `${BLOB_KEY} is already set to a different value. Use \`meander blob key rotate\` to replace it.`,
    )
  }

  await deps.env.setEnvVar(BLOB_KEY, hex)
  deps.io.printLine(`  Set ${BLOB_KEY}`)
  deps.io.printLine('')
  deps.io.printLine(
    'Local env: set the same key in your shell so `meander publish` works:',
  )
  deps.io.printLine('')
  deps.io.printLine(`  export ${BLOB_KEY}=${hex}`)
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
 * NB: this command consciously echoes a wrapping key. It's the
 * sole interactive way to bootstrap a new operator's laptop;
 * pipe the output into the operator's password manager rather
 * than letting it sit in shell history.
 */
export async function blobKeyShow(deps: CeremonyDeps): Promise<void> {
  const existing = await deps.env.getEnvVar(BLOB_KEY)
  if (!existing) {
    throw new Error(
      `${BLOB_KEY} not set on val — run \`meander blob key init\` first`,
    )
  }
  /* Print only — no labels — so callers can pipe into pbcopy/etc.
   * `meander blob key show <name> | pbcopy` works without trimming. */
  deps.io.printLine(existing)
}
