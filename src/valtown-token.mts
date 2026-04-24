/**
 * Val Town token resolution with a configurable env-var name.
 *
 * Consumers who already have a different GitHub-secret name
 * (e.g. `MY_VALTOWN_TOKEN`, `CI_VT_TOKEN`) can point meander at
 * their name without renaming the underlying secret. Two ways
 * to override the default `VALTOWN_TOKEN`:
 *
 *   1. Set `MEANDER_VALTOWN_TOKEN_ENV=MY_TOKEN_NAME` in the
 *      environment. meander reads that meta-var first, then
 *      looks up the named env var for the actual token.
 *   2. Pass `--token-env MY_TOKEN_NAME` to the CLI (wired by
 *      cli.mts; this module just consumes the resolved name).
 *
 * Returns `null` when no token is available. Callers decide
 * whether absence is fatal (deploy-val / publish require it)
 * or graceful (CI that wants to skip comment-backend deploys
 * on fork PRs or when the secret isn't provisioned).
 */

export type TokenResolution = {
  /** Name of the env var that was read (for error messages). */
  envName: string
  /** The token value, or null if unset / empty. */
  token: string | null
}

export function resolveValTownToken(
  envName?: string | undefined,
): TokenResolution {
  /* If caller didn't pass an explicit name, consult the
   * meta-var. Fall back to `VALTOWN_TOKEN` — matches the
   * convention used by the Val Town CLI and every fleet repo
   * before meander gained configurability. */
  const resolvedName =
    envName ?? process.env['MEANDER_VALTOWN_TOKEN_ENV'] ?? 'VALTOWN_TOKEN'
  const token = process.env[resolvedName] ?? null
  return {
    envName: resolvedName,
    token: token && token.length > 0 ? token : null,
  }
}

/**
 * Format a consistent "missing token" message. Used by both the
 * fatal-error and graceful-degrade paths so error output stays
 * uniform across commands.
 */
export function missingTokenMessage(envName: string): string {
  const lines = [
    `Val Town token not found in env var "${envName}".`,
    `To provide the token:`,
    `  • export ${envName}="vtwn_…" (local dev)`,
    `  • Settings → Secrets and variables → Actions → New (CI)`,
    `To change the env-var name meander reads from:`,
    `  • set MEANDER_VALTOWN_TOKEN_ENV=<your-name> in the env, or`,
    `  • pass --token-env <your-name> to the CLI command.`,
  ]
  return lines.join('\n  ')
}
