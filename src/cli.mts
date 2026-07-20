import { parseArgs } from 'node:util'
import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'
import { errorMessage } from '@socketsecurity/lib/errors/message'

const logger = getDefaultLogger()

const command = process.argv[2]
const commandArgs = process.argv.slice(3)

const HELP_TEXT = `meander — walkthrough generator with comments

Commands:
  meander generate <meander.config.json>   Generate walkthrough HTML
  meander serve <meander.config.json>      Generate + start local preview
  meander publish <meander.config.json>    Publish HTML to Val Town blob storage
  meander deploy-val [val-name]            Deploy or update the Val Town val
  meander db key <verb> [val-name]         Manage the comment-store wrapping key
                                           (init / rotate / restore / audit / retire)
  meander blob key <verb> [val-name]       Manage the walkthrough-blob wrapping key
                                           (init / rotate / restore / show)
  meander doctor                           Report system + peer-dep status

Flags (publish, deploy-val):
  --token-env <NAME>    Env var to read for the bearer token (default:
                        $MEANDER_VALTOWN_TOKEN_ENV or VALTOWN_TOKEN)
  --graceful            Missing token / creds → warn + exit 0 instead of
                        throwing. For CI jobs that shouldn't fail when the
                        secret isn't provisioned (fork PRs, demo setups).

Flags (deploy-val only):
  --out-dir <name>             Blob-key prefix the val reads from. Must match
                               what 'meander publish' uploads to. Default: pages.
  --allowed-domains <csv>      Comma-separated email-domain allowlist the val
                               accepts for writes. Empty (default) means writes
                               are refused — the safe starting posture.
  --demo-mode                  Deploy the val in demo mode: comment UI renders
                               a banner and writes return 403.

Flags (db key, blob key):
  --threshold <N>              Shamir threshold (init/rotate/restore). Default: 2.
  --shares <N>                 Shamir total share count (init/rotate). Default: 3.
  --share-file <path>          Read a share from a file (repeatable, rotate/restore).
                               Otherwise prompts interactively.
  --generation <N>             Generation to operate on (db key retire only).

Environment variables:
  VALTOWN_TOKEN              Val Town API bearer token (default env name).
                             See docs/deploying.md for scopes.
  MEANDER_VALTOWN_TOKEN_ENV  Override the env-var name meander reads the
                             token from. Set to e.g. "MY_VT_TOKEN" if your
                             GitHub secret has a different name.
  MEANDER_BLOB_KEY           Hex-encoded 32-byte wrapping key for envelope
                             blob encryption. Required by publish only when
                             encryptBlobs: true in meander.config.json.
                             Generate with \`meander blob key init\`. See
                             docs/encryption.md for the envelope scheme.`

/**
 * Resolve the val + admin token + build the production
 * CeremonyDeps. Used by both `db key` and `blob key` dispatchers.
 */
export async function buildCeremonyDeps(args: CeremonyParsedArgs) {
  const { resolveValTownToken, missingTokenMessage } =
    await import('./valtown-token.mts')
  const { resolveVal } = await import('./valtown-env.mts')
  const { createDefaultDeps, createEnvClient } =
    await import('./ceremony-deps.mts')
  const { envName, token } = resolveValTownToken(args.tokenEnv)
  if (!token) {
    throw new Error(missingTokenMessage(envName))
  }
  const val = await resolveVal(token, args.valName)
  /* The admin token lives on the val itself — fetch it via the env
   * API so the ceremony can authenticate to /admin/* endpoints. */
  const env = createEnvClient(token, val.id)
  const adminToken = await env.getEnvVar('MEANDER_ADMIN_TOKEN')
  if (!adminToken) {
    throw new Error(
      'MEANDER_ADMIN_TOKEN not set on val — run `meander deploy-val` first to mint it',
    )
  }
  return createDefaultDeps(token, val, adminToken, args.shareFiles)
}

/**
 * Parse + dispatch `meander blob <subcommand>`. Today only the
 * `blob key <verb>` subtree is implemented.
 */
export async function dispatchBlob(args: readonly string[]): Promise<void> {
  const sub = args[0]
  if (sub !== 'key') {
    logger.fail(
      `Usage: meander blob key <init|rotate|restore|show> [val-name] [flags]`,
    )
    process.exitCode = 1
    return
  }
  const verb = args[1]
  if (!verb) {
    logger.fail(
      `Usage: meander blob key <init|rotate|restore|show> [val-name] [flags]`,
    )
    process.exitCode = 1
    return
  }
  const parsed = parseCeremonyArgs(args.slice(2))
  const blobKey = await import('./blob-key.mts')
  const opts = { threshold: parsed.threshold, shares: parsed.shares }
  switch (verb) {
    case 'init': {
      const deps = await buildCeremonyDeps(parsed)
      await blobKey.blobKeyInit(opts, deps)
      break
    }
    case 'rotate': {
      const deps = await buildCeremonyDeps(parsed)
      await blobKey.blobKeyRotate(opts, deps)
      break
    }
    case 'restore': {
      const deps = await buildCeremonyDeps(parsed)
      await blobKey.blobKeyRestore(opts, deps)
      break
    }
    case 'show': {
      const deps = await buildCeremonyDeps(parsed)
      await blobKey.blobKeyShow(deps)
      break
    }
    default:
      logger.fail(
        `Unknown subcommand: meander blob key ${verb}\n` +
          `Usage: meander blob key <init|rotate|restore|show> [val-name]`,
      )
      process.exitCode = 1
  }
}

/**
 * Parse + dispatch `meander db <subcommand>`. Today only the
 * `db key <verb>` subtree is implemented; future commands like
 * `db backup` / `db restore` slot in here.
 */
export async function dispatchDb(args: readonly string[]): Promise<void> {
  const sub = args[0]
  if (sub !== 'key') {
    logger.fail(
      `Usage: meander db key <init|rotate|restore|audit|retire> [val-name] [flags]`,
    )
    process.exitCode = 1
    return
  }
  const verb = args[1]
  if (!verb) {
    logger.fail(
      `Usage: meander db key <init|rotate|restore|audit|retire> [val-name] [flags]`,
    )
    process.exitCode = 1
    return
  }
  const parsed = parseCeremonyArgs(args.slice(2))
  const dbKey = await import('./db-key.mts')
  const opts = {
    threshold: parsed.threshold,
    shares: parsed.shares,
    generation: parsed.generation,
  }
  switch (verb) {
    case 'init': {
      const deps = await buildCeremonyDeps(parsed)
      await dbKey.dbKeyInit(opts, deps)
      break
    }
    case 'rotate': {
      const deps = await buildCeremonyDeps(parsed)
      await dbKey.dbKeyRotate(opts, deps)
      break
    }
    case 'restore': {
      const deps = await buildCeremonyDeps(parsed)
      await dbKey.dbKeyRestore(opts, deps)
      break
    }
    case 'audit': {
      const deps = await buildCeremonyDeps(parsed)
      await dbKey.dbKeyAudit(deps)
      break
    }
    case 'retire': {
      const deps = await buildCeremonyDeps(parsed)
      await dbKey.dbKeyRetire(opts, deps)
      break
    }
    default:
      logger.fail(
        `Unknown subcommand: meander db key ${verb}\n` +
          `Usage: meander db key <init|rotate|restore|audit|retire> [val-name]`,
      )
      process.exitCode = 1
  }
}

export function firstPositional(args: readonly string[]): string | undefined {
  const { positionals } = parseArgs({
    args: args as string[],
    strict: false,
    allowPositionals: true,
  })
  return positionals[0]
}

export type CeremonyParsedArgs = {
  valName: string
  tokenEnv: string | undefined
  threshold: number | undefined
  shares: number | undefined
  shareFiles: readonly string[]
  generation: number | undefined
}

export function parseCeremonyArgs(rest: readonly string[]): CeremonyParsedArgs {
  const { values, positionals } = parseArgs({
    args: rest as string[],
    options: {
      'token-env': { type: 'string' },
      threshold: { type: 'string' },
      shares: { type: 'string' },
      'share-file': { type: 'string', multiple: true },
      generation: { type: 'string' },
    },
    strict: false,
    allowPositionals: true,
  })
  const out: CeremonyParsedArgs = {
    valName: positionals[0] ?? 'walkthrough',
    tokenEnv: undefined,
    threshold: undefined,
    shares: undefined,
    shareFiles: [],
    generation: undefined,
  }
  if (typeof values['token-env'] === 'string') {
    out.tokenEnv = values['token-env']
  }
  if (typeof values['threshold'] === 'string') {
    out.threshold = Number(values['threshold'])
  }
  if (typeof values['shares'] === 'string') {
    out.shares = Number(values['shares'])
  }
  if (Array.isArray(values['share-file'])) {
    out.shareFiles = values['share-file'] as string[]
  }
  if (typeof values['generation'] === 'string') {
    out.generation = Number(values['generation'])
  }
  return out
}

/**
 * The Val Town flags shared by `publish` + `deploy-val`:
 * --token-env <NAME>  env var meander reads for the Val Town bearer token
 * (default: $MEANDER_VALTOWN_TOKEN_ENV or VALTOWN_TOKEN)
 * --graceful          missing token / creds warn + exit 0 instead of
 * throwing. For CI workflows that should not fail when
 * the secret isn't provisioned (fork PRs, demo setups).
 */
export function parseValTownFlags(args: readonly string[]): {
  tokenEnv: string | undefined
  graceful: boolean
} {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      'token-env': { type: 'string' },
      graceful: { type: 'boolean', default: false },
    },
    strict: false,
    allowPositionals: true,
  })
  return {
    tokenEnv: values['token-env'] as string | undefined,
    graceful: values['graceful'] === true,
  }
}

export function usage(cmd: 'generate' | 'publish' | 'serve'): string {
  const form = '<meander.config.json>'
  switch (cmd) {
    case 'generate':
      return `Usage: meander generate ${form} [--base-path <path>] [--asset-dir <dir>]`
    case 'publish':
      return `Usage: meander publish ${form} [--token-env <name>] [--graceful]`
    case 'serve':
      return `Usage: meander serve ${form} [--port N] [--base-path <path>]`
  }
}

async function main() {
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP_TEXT + '\n')
    return
  }
  switch (command) {
    case 'generate': {
      const { values, positionals } = parseArgs({
        args: commandArgs,
        options: {
          'base-path': { type: 'string' },
          'asset-dir': { type: 'string' },
        },
        strict: false,
        allowPositionals: true,
      })
      const configPath = positionals[0]
      if (!configPath) {
        logger.fail(usage('generate'))
        process.exitCode = 1
        return
      }
      const options: {
        basePath?: string | undefined
        assetDir?: string | undefined
        __proto__: null
      } = { __proto__: null }
      if (typeof values['base-path'] === 'string') {
        options.basePath = values['base-path']
      }
      if (typeof values['asset-dir'] === 'string') {
        options.assetDir = values['asset-dir']
      }
      const { generate } = await import('./generate.mts')
      await generate(configPath, options)
      break
    }
    case 'publish': {
      const configPath = firstPositional(commandArgs)
      if (!configPath) {
        logger.fail(usage('publish'))
        process.exitCode = 1
        return
      }
      const { publish } = await import('./publish.mts')
      await publish(configPath, parseValTownFlags(commandArgs))
      break
    }
    case 'deploy-val': {
      const { values, positionals } = parseArgs({
        args: commandArgs,
        options: {
          'token-env': { type: 'string' },
          graceful: { type: 'boolean', default: false },
          'out-dir': { type: 'string' },
          'allowed-domains': { type: 'string' },
          'demo-mode': { type: 'boolean', default: false },
        },
        strict: false,
        allowPositionals: true,
      })
      const valName = positionals[0] ?? 'walkthrough'
      const { deployVal } = await import('./deploy-val.mts')
      await deployVal(valName, {
        tokenEnv: values['token-env'] as string | undefined,
        graceful: values['graceful'] === true,
        outDir: (values['out-dir'] as string | undefined) ?? 'pages',
        allowedEmailDomains:
          (values['allowed-domains'] as string | undefined) ?? '',
        demoMode: values['demo-mode'] === true,
      })
      break
    }
    case 'doctor': {
      const { doctor } = await import('./doctor.mts')
      await doctor()
      break
    }
    case 'db': {
      await dispatchDb(commandArgs)
      break
    }
    case 'blob': {
      await dispatchBlob(commandArgs)
      break
    }
    case 'serve': {
      /* Local preview server. Generates first so the output
       * reflects the latest source, then serves. --port 0 picks
       * a free port; --base-path matches the generator's. */
      const { values, positionals } = parseArgs({
        args: commandArgs,
        options: {
          port: { type: 'string' },
          'base-path': { type: 'string' },
        },
        strict: false,
        allowPositionals: true,
      })
      const configPath = positionals[0]
      if (!configPath) {
        logger.fail(usage('serve'))
        process.exitCode = 1
        return
      }
      const options: {
        port?: number | undefined
        basePath?: string | undefined
        __proto__: null
      } = { __proto__: null }
      if (typeof values['port'] === 'string') {
        options.port = Number(values['port'])
      }
      if (typeof values['base-path'] === 'string') {
        options.basePath = values['base-path']
      }
      const { generate } = await import('./generate.mts')
      await generate(configPath, { basePath: options.basePath })
      const { serve } = await import('./serve.mts')
      await serve(configPath, options)
      break
    }
    default: {
      logger.fail(HELP_TEXT)
      if (command) {
        logger.error('')
        logger.fail(`Unknown command: ${command}`)
      }
      process.exitCode = 1
    }
  }
}

main().catch(e => {
  logger.fail(e instanceof Error ? errorMessage(e) : String(e))
  process.exitCode = 1
})
