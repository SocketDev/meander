import ValTown from '@valtown/sdk'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { missingTokenMessage, resolveValTownToken } from './valtown-token.mts'

const API_BASE = 'https://api.val.town'

function getValSourcePath(): string {
  const thisFile = fileURLToPath(import.meta.url)
  return path.join(path.dirname(thisFile), '..', 'assets', 'val', 'index.ts')
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
}

export async function deployVal(
  valName: string,
  options: DeployValOptions = { __proto__: null } as DeployValOptions,
): Promise<void> {
  const { tokenEnv, graceful = false } = {
    __proto__: null,
    ...options,
  } as DeployValOptions

  const { envName, token } = resolveValTownToken(tokenEnv)
  if (!token) {
    const msg = missingTokenMessage(envName)
    if (graceful) {
      console.log(`[deploy-val] skipped — ${msg}`)
      return
    }
    throw new Error(msg)
  }

  const walkthroughUser: string = process.env['WALKTHROUGH_USER'] ?? ''
  const walkthroughPass: string = process.env['WALKTHROUGH_PASS'] ?? ''
  if (!walkthroughUser || !walkthroughPass) {
    const msg =
      'WALKTHROUGH_USER and WALKTHROUGH_PASS environment variables are required for deploy-val.'
    if (graceful) {
      console.log(`[deploy-val] skipped — ${msg}`)
      return
    }
    throw new Error(msg)
  }

  const client = new ValTown({ bearerToken: token })

  const valSource = readFileSync(getValSourcePath(), 'utf-8')

  const profile = await client.me.profile.retrieve()
  const username = profile.username ?? ''
  console.log(`Logged in as: ${username}`)
  console.log(`Looking for existing val "${valName}"...`)

  let valId: string | null = null
  try {
    const val = await client.alias.username.valName.retrieve(username, valName)
    valId = val.id
  } catch {
    valId = null
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

  // Update the HTTP trigger file
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

  // Set environment variables
  console.log('Setting environment variables...')
  for (const [key, value] of [
    ['WALKTHROUGH_USER', walkthroughUser],
    ['WALKTHROUGH_PASS', walkthroughPass],
  ] satisfies Array<[string, string]>) {
    const updateRes = await fetch(
      `${API_BASE}/v2/vals/${valId}/environment_variables/${key}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value }),
      },
    )
    if (updateRes.ok) {
      console.log(`  Updated ${key}`)
      continue
    }

    const createRes = await fetch(
      `${API_BASE}/v2/vals/${valId}/environment_variables`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key, value }),
      },
    )
    if (createRes.ok) {
      console.log(`  Created ${key}`)
      continue
    }

    throw new Error(
      `Failed to set env var ${key}: ${createRes.status} ${await createRes.text()}`,
    )
  }

  const val = await client.vals.retrieve(valId)
  console.log(`\nDone! Val URL: ${val.links.html}`)
}
