import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ValTown from '@valtown/sdk'

import { generateSecret, getEnvVar, setEnvVar } from './valtown-env.mts'
import { missingTokenMessage, resolveValTownToken } from './valtown-token.mts'

function getValSourcePath(): string {
  const thisFile = fileURLToPath(import.meta.url)
  return path.join(path.dirname(thisFile), '..', 'assets', 'val', 'index.ts')
}

/**
 * Bundle the val's `index.ts` + its `lib/*.ts` helpers into a
 * single Deno-compatible source string. The Val Town upload
 * API takes one file per path; bundling sidesteps uploading
 * the whole `lib/` tree.
 *
 * External: `npm:*`, `https://esm.town/*` — Deno resolves those
 * at runtime.
 */
async function bundleValSource(entryPath: string): Promise<string> {
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    platform: 'neutral',
    format: 'esm',
    target: 'deno2',
    external: ['npm:*', 'https://*', 'jsr:*'],
  })
  const file = result.outputFiles?.[0]
  if (!file) {
    throw new Error('esbuild produced no output for the val bundle')
  }
  return file.text
}

export type DeployValOptions = {
  /** Override the env var read for the bearer token. Default:
   *  MEANDER_VALTOWN_TOKEN_ENV or VALTOWN_TOKEN. */
  tokenEnv?: string | undefined
  /** When true, missing token / auth creds log a warning and
   *  return 0 instead of throwing. Used by CI workflows where
   *  the comment-backend deploy is opt-in (e.g. public fork PRs
   *  that never get the secret). */
  graceful?: boolean | undefined
  /** Blob-key prefix the val should read from. Matches whatever
   *  `meander publish` uploads to. Default: "pages". */
  outDir?: string | undefined
  /** Comma-separated email-domain allowlist written to the val's
   *  env. Default: empty (val refuses writes until configured). */
  allowedEmailDomains?: string | undefined
  /** When true, the val returns 403 on writes + the comment UI
   *  shows a "demo" banner. Default: false. */
  demoMode?: boolean | undefined
}

export async function deployVal(
  valName: string,
  options: DeployValOptions = { __proto__: null } as DeployValOptions,
): Promise<void> {
  const {
    tokenEnv,
    graceful = false,
    outDir = 'pages',
    allowedEmailDomains = '',
    demoMode = false,
  } = { __proto__: null, ...options } as DeployValOptions

  const { envName, token } = resolveValTownToken(tokenEnv)
  if (!token) {
    const msg = missingTokenMessage(envName)
    if (graceful) {
      console.log(`[deploy-val] skipped — ${msg}`)
      return
    }
    throw new Error(msg)
  }

  const client = new ValTown({ bearerToken: token })
  const valSource = await bundleValSource(getValSourcePath())

  const profile = await client.me.profile.retrieve()
  const username = profile.username ?? ''
  console.log(`Logged in as: ${username}`)
  console.log(`Looking for existing val "${valName}"...`)

  let valId: string | undefined
  try {
    const val = await client.alias.username.valName.retrieve(username, valName)
    valId = val.id
  } catch {
    valId = undefined
  }

  if (valId) {
    console.log(`Found existing val: ${valId}`)
  } else {
    console.log(`Creating new val "${valName}"...`)
    const created = await client.vals.create({
      name: valName,
      privacy: 'unlisted',
      description: 'Walkthrough viewer with comments',
    })
    valId = created.id
    console.log(`Created val: ${valId}`)
  }

  console.log('Updating val source code...')
  try {
    await client.vals.files.update(valId, {
      path: 'index.ts',
      content: valSource,
      type: 'http',
    })
    console.log('Updated index.ts')
  } catch {
    await client.vals.files.create(valId, {
      path: 'index.ts',
      content: valSource,
      type: 'http',
    })
    console.log('Created index.ts')
  }

  /* Env var list. MEANDER_JWT_SECRET + MEANDER_ADMIN_TOKEN are
   * minted once + preserved across deploys — we only write them
   * when missing. Wrapping keys (MEANDER_DB_KEY_<n>,
   * MEANDER_BLOB_KEY) are *not* set here: those are managed by
   * the `meander db key` and `meander blob key` ceremonies, which
   * control share distribution and the generation pointer.
   * deploy-val only handles the val's non-key configuration. */
  const envVars: Array<{ key: string; value: string; preserveIfSet?: true }> = [
    { key: 'MEANDER_OUT_DIR', value: outDir },
    { key: 'MEANDER_ALLOWED_EMAIL_DOMAINS', value: allowedEmailDomains },
    { key: 'MEANDER_DEMO_MODE', value: demoMode ? 'true' : 'false' },
    {
      key: 'MEANDER_JWT_SECRET',
      value: generateSecret(48),
      preserveIfSet: true,
    },
    {
      key: 'MEANDER_ADMIN_TOKEN',
      value: generateSecret(32),
      preserveIfSet: true,
    },
  ]

  console.log('Setting environment variables...')
  for (const { key, value, preserveIfSet } of envVars) {
    if (preserveIfSet) {
      const existing = await getEnvVar(token, valId, key)
      if (existing) {
        console.log(`  Preserved ${key} (already set)`)
        continue
      }
    }
    await setEnvVar(token, valId, key, value)
    console.log(`  Set ${key}`)
  }

  const val = await client.vals.retrieve(valId)
  console.log(`\nDone! Val URL: ${val.links.html}`)
  if (!allowedEmailDomains) {
    console.log(
      '\nNote: MEANDER_ALLOWED_EMAIL_DOMAINS is empty — writes will be refused.',
    )
    console.log(
      '      Set it via --allowed-domains=gmail.com,example.com or the val settings.',
    )
  }
}
