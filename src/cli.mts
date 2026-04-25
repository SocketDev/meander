import { parseArgs } from 'node:util'

const command = process.argv[2]
const commandArgs = process.argv.slice(3)

/**
 * The Val Town flags shared by `publish` + `deploy-val`:
 *   --token-env <NAME>  env var meander reads for the Val Town bearer token
 *                       (default: $MEANDER_VALTOWN_TOKEN_ENV or VALTOWN_TOKEN)
 *   --graceful          missing token / creds warn + exit 0 instead of
 *                       throwing. For CI workflows that should not fail when
 *                       the secret isn't provisioned (fork PRs, demo setups).
 */
function parseValTownFlags(args: readonly string[]): {
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

function firstPositional(args: readonly string[]): string | undefined {
  const { positionals } = parseArgs({
    args: args as string[],
    strict: false,
    allowPositionals: true,
  })
  return positionals[0]
}

function usage(cmd: 'generate' | 'publish' | 'serve'): string {
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
        console.error(usage('generate'))
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
        console.error(usage('publish'))
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
        console.error(usage('serve'))
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
      console.error(`meander — walkthrough generator with comments

Commands:
  meander generate <meander.config.json>   Generate walkthrough HTML
  meander serve <meander.config.json>      Generate + start local preview
  meander publish <meander.config.json>    Publish HTML to Val Town blob storage
  meander deploy-val [val-name]            Deploy or update the Val Town val
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
                             docs/encryption.md for the envelope scheme.`)
      if (command) {
        console.error(`\nUnknown command: ${command}`)
      }
      process.exitCode = 1
    }
  }
}

main().catch(e => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e))
  process.exitCode = 1
})
