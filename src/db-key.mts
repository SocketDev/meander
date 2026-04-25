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
 *
 * Each function takes a `CeremonyDeps` injection seam — see
 * src/ceremony-deps.mts. In production the CLI builds deps from
 * VALTOWN_TOKEN + the val's URL; tests pass in-memory fakes.
 */

import { combine, split } from './shamir.mts'
import {
  bytesToHex,
  gatherShares,
  printShares,
  validateShamirParams,
  type CeremonyDeps,
} from './ceremony-deps.mts'

const DB_KEY_PREFIX = 'MEANDER_DB_KEY_'
const DB_KEY_CURRENT = 'MEANDER_DB_KEY_CURRENT'

export type DbKeyOptions = {
  /** Shamir threshold (min shares to reconstruct). Default: 2. */
  threshold?: number | undefined
  /** Shamir total share count. Default: 3. */
  shares?: number | undefined
  /** Generation to operate on (retire only). */
  generation?: number | undefined
}

/* ------------------------------------------------------------------ */
/*  Helpers shared across subcommands                                   */
/* ------------------------------------------------------------------ */

type EnvSnapshot = {
  generations: number[]
  currentGeneration: number | undefined
}

async function snapshotEnv(deps: CeremonyDeps): Promise<EnvSnapshot> {
  const names = await deps.env.listEnvVarNames()
  const generations = names
    .filter(n => n.startsWith(DB_KEY_PREFIX) && n !== DB_KEY_CURRENT)
    .map(n => Number.parseInt(n.slice(DB_KEY_PREFIX.length), 10))
    .filter(n => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
  let currentGeneration: number | undefined
  const currentRaw = await deps.env.getEnvVar(DB_KEY_CURRENT)
  if (currentRaw) {
    const n = Number.parseInt(currentRaw, 10)
    if (Number.isInteger(n) && n > 0) {
      currentGeneration = n
    }
  }
  return { generations, currentGeneration }
}

/* ------------------------------------------------------------------ */
/*  init                                                                */
/* ------------------------------------------------------------------ */

export async function dbKeyInit(
  options: DbKeyOptions,
  deps: CeremonyDeps,
): Promise<void> {
  const threshold = options.threshold ?? 2
  const sharesCount = options.shares ?? 3
  validateShamirParams(threshold, sharesCount)

  const snapshot = await snapshotEnv(deps)
  if (snapshot.generations.length > 0) {
    throw new Error(
      `${DB_KEY_PREFIX}<n> already exists on val (generations: ${snapshot.generations.join(', ')}). Use \`meander db key rotate\` instead.`,
    )
  }

  deps.io.printLine(
    `Generating wrapping key (${threshold}-of-${sharesCount} Shamir)...`,
  )
  const key = deps.randomWrappingKey()
  const shares = split(new Uint8Array(key), threshold, sharesCount)

  await deps.env.setEnvVar(`${DB_KEY_PREFIX}1`, bytesToHex(key))
  deps.io.printLine(`  Set ${DB_KEY_PREFIX}1`)
  await deps.env.setEnvVar(DB_KEY_CURRENT, '1')
  deps.io.printLine(`  Set ${DB_KEY_CURRENT}=1`)

  printShares(deps.io, shares, threshold, 'comment-store')
}

/* ------------------------------------------------------------------ */
/*  rotate                                                              */
/* ------------------------------------------------------------------ */

export async function dbKeyRotate(
  options: DbKeyOptions,
  deps: CeremonyDeps,
): Promise<void> {
  const threshold = options.threshold ?? 2
  const sharesCount = options.shares ?? 3
  validateShamirParams(threshold, sharesCount)

  const snapshot = await snapshotEnv(deps)
  if (snapshot.currentGeneration === undefined) {
    throw new Error(
      `${DB_KEY_CURRENT} not set on val — run \`meander db key init\` first`,
    )
  }
  const fromGen = snapshot.currentGeneration
  const toGen = Math.max(...snapshot.generations) + 1

  deps.io.printLine(`Rotating from generation ${fromGen} to ${toGen}...`)
  deps.io.printLine(
    `  Reconstruct generation ${fromGen} from ${threshold} shares to verify.`,
  )
  const oldShares = await gatherShares(deps.io, threshold)
  const recovered = combine(oldShares)

  /* Sanity check: the reconstructed key must match the current
   * MEANDER_DB_KEY_<fromGen> on the val. If not, the operator
   * supplied bad shares — bail before changing anything. */
  const currentHex = await deps.env.getEnvVar(`${DB_KEY_PREFIX}${fromGen}`)
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

  const newKey = deps.randomWrappingKey()
  const newShares = split(new Uint8Array(newKey), threshold, sharesCount)

  /* Plant the new generation. Don't flip CURRENT yet — the val
   * needs to be able to decrypt the old generation's rows during
   * rewrap. CURRENT moves AFTER rewrap finishes. */
  await deps.env.setEnvVar(`${DB_KEY_PREFIX}${toGen}`, bytesToHex(newKey))
  deps.io.printLine(`  Set ${DB_KEY_PREFIX}${toGen}`)

  /* Drive /admin/rewrap until the val reports remaining = 0. */
  deps.io.printLine(
    `  Rewrapping rows from generation ${fromGen} to ${toGen}...`,
  )
  let totalRewrapped = 0
  while (true) {
    const body = await deps.admin.rewrap({
      fromGeneration: fromGen,
      toGeneration: toGen,
      batchSize: 100,
    })
    totalRewrapped += body.rewrapped
    deps.io.printLine(
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
  deps.io.printLine(`  Rewrapped ${totalRewrapped} rows total`)

  /* Atomic flip: now point CURRENT at the new generation. New
   * writes from this point use the new key. */
  await deps.env.setEnvVar(DB_KEY_CURRENT, String(toGen))
  deps.io.printLine(`  Set ${DB_KEY_CURRENT}=${toGen}`)

  printShares(deps.io, newShares, threshold, 'comment-store')
  deps.io.printLine(
    `\nGeneration ${fromGen} remains in env; use \`meander db key retire ${fromGen}\` after backing up.`,
  )
}

/* ------------------------------------------------------------------ */
/*  restore                                                             */
/* ------------------------------------------------------------------ */

export async function dbKeyRestore(
  options: DbKeyOptions,
  deps: CeremonyDeps,
): Promise<void> {
  const threshold = options.threshold ?? 2
  validateShamirParams(threshold, threshold)

  const snapshot = await snapshotEnv(deps)
  deps.io.printLine(`Restoring wrapping key from ${threshold} shares...`)
  const shares = await gatherShares(deps.io, threshold)
  const recovered = combine(shares)
  const recoveredHex = bytesToHex(recovered)

  /* Find which generation these shares correspond to. Each
   * MEANDER_DB_KEY_<n> in env is checked — if the operator
   * supplied shares of a generation that was wiped, no match
   * means we plant a new generation slot. */
  let matchedGen: number | undefined
  for (const gen of snapshot.generations) {
    const existing = await deps.env.getEnvVar(`${DB_KEY_PREFIX}${gen}`)
    if (existing === recoveredHex) {
      matchedGen = gen
      break
    }
  }

  if (matchedGen !== undefined) {
    deps.io.printLine(
      `  Shares match existing ${DB_KEY_PREFIX}${matchedGen} — nothing to restore`,
    )
    return
  }

  /* No match. The most likely scenario: env was wiped and we're
   * planting back. Use the lowest-numbered missing generation
   * (typically 1 if everything is gone). */
  const planTarget =
    snapshot.generations.length > 0 ? Math.max(...snapshot.generations) + 1 : 1
  await deps.env.setEnvVar(`${DB_KEY_PREFIX}${planTarget}`, recoveredHex)
  deps.io.printLine(`  Set ${DB_KEY_PREFIX}${planTarget}`)
  if (snapshot.currentGeneration === undefined) {
    await deps.env.setEnvVar(DB_KEY_CURRENT, String(planTarget))
    deps.io.printLine(`  Set ${DB_KEY_CURRENT}=${planTarget}`)
  }
}

/* ------------------------------------------------------------------ */
/*  audit                                                               */
/* ------------------------------------------------------------------ */

export async function dbKeyAudit(deps: CeremonyDeps): Promise<void> {
  const body = await deps.admin.keyAudit()
  deps.io.printLine(
    `Visible generations: ${body.visibleGenerations.join(', ')}`,
  )
  deps.io.printLine(`Current (used for new writes): ${body.currentGeneration}`)
  deps.io.printLine('Row counts by generation:')
  const sortedGens = Object.keys(body.rowCounts)
    .map(Number)
    .sort((a, b) => a - b)
  if (sortedGens.length === 0) {
    deps.io.printLine('  (no comments)')
  }
  for (const gen of sortedGens) {
    const n = body.rowCounts[String(gen)]!
    const marker = gen === body.currentGeneration ? ' ← current' : ''
    deps.io.printLine(`  generation ${gen}: ${n} row(s)${marker}`)
  }
  /* Also surface generations in env that don't appear in counts —
   * those are decommissionable via retire. */
  for (const gen of body.visibleGenerations) {
    if (gen !== body.currentGeneration && !(String(gen) in body.rowCounts)) {
      deps.io.printLine(
        `  generation ${gen}: 0 rows — eligible for \`meander db key retire ${gen}\``,
      )
    }
  }
}

/* ------------------------------------------------------------------ */
/*  retire                                                              */
/* ------------------------------------------------------------------ */

export async function dbKeyRetire(
  options: DbKeyOptions,
  deps: CeremonyDeps,
): Promise<void> {
  const target = options.generation
  if (target === undefined || !Number.isInteger(target) || target <= 0) {
    throw new Error('--generation <n> required (positive integer)')
  }
  const snapshot = await snapshotEnv(deps)
  if (target === snapshot.currentGeneration) {
    throw new Error(
      `cannot retire generation ${target} — it is the current generation`,
    )
  }
  if (!snapshot.generations.includes(target)) {
    throw new Error(
      `generation ${target} is not present in env (visible: ${snapshot.generations.join(', ')})`,
    )
  }

  /* Pre-flight: refuse if any rows still reference target. */
  const audit = await deps.admin.keyAudit()
  const stillReferenced = audit.rowCounts[String(target)] ?? 0
  if (stillReferenced > 0) {
    throw new Error(
      `${stillReferenced} row(s) still reference generation ${target} — run \`meander db key rotate\` first to migrate them off`,
    )
  }

  const removed = await deps.env.deleteEnvVar(`${DB_KEY_PREFIX}${target}`)
  if (!removed) {
    deps.io.printLine(
      `  ${DB_KEY_PREFIX}${target} was not present (nothing to remove)`,
    )
    return
  }
  deps.io.printLine(`  Removed ${DB_KEY_PREFIX}${target}`)
}
