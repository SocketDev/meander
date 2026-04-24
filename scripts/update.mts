/**
 * Update: two-pass taze to apply the fleet's maturity policy
 * correctly.
 *
 *   Pass 1: taze with its default config loaded (maturityPeriod
 *     7, Socket-owned scopes in exclude). Non-Socket deps bump
 *     only if they've been stable for a week — the cooldown
 *     lets the ecosystem catch compromised releases.
 *
 *   Pass 2: taze with CLI flags scoped to Socket-owned packages
 *     only, maturityPeriod 0. Fresh Socket releases land
 *     immediately since we trust our own publish pipeline.
 *     Done via CLI flags rather than a second config file
 *     because taze's config auto-discovery is path-based and
 *     doesn't support a --config override.
 *
 *   Pass 3: pnpm install to refresh the lockfile against the
 *     updated package.json.
 *
 * SOCKET_SCOPES below MUST match the `exclude` list in
 * .config/taze.config.mts — if they drift, packages either get
 * double-bumped or missed entirely.
 *
 * Review the diff before committing.
 */
import { spawn } from '@socketsecurity/lib/spawn'

async function run(cmd: string, args: string[]): Promise<boolean> {
  try {
    await spawn(cmd, args, { stdio: 'inherit' })
    return true
  } catch (e) {
    process.exitCode = (e as { code?: number }).code ?? 1
    return false
  }
}

/* Socket-owned scopes — kept in lockstep with the exclude list
 * in .config/taze.config.mts. */
const SOCKET_SCOPES = [
  '@socketregistry/*',
  '@socketsecurity/*',
  '@socketdev/*',
  'socket-*',
  'ecc-agentshield',
  'sfw',
]

const steps: Array<[string, string[]]> = [
  /* Pass 1 — everything except Socket packages, with cooldown. */
  ['pnpm', ['exec', 'taze']],
  /* Pass 2 — Socket packages only, no cooldown. taze's
   * --include filter is comma-separated. */
  [
    'pnpm',
    [
      'exec',
      'taze',
      '--include',
      SOCKET_SCOPES.join(','),
      '--maturity-period',
      '0',
      '--write',
    ],
  ],
  /* Pass 3 — resync lockfile against updated package.json. */
  ['pnpm', ['install']],
]

for (const [cmd, args] of steps) {
  if (!(await run(cmd, args))) {
    break
  }
}
