import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { deriveKey, encrypt } from './crypto.mts'
import { missingTokenMessage, resolveValTownToken } from './valtown-token.mts'

const API_BASE = 'https://api.val.town'

export type PublishOptions = {
  /** Override the env var read for the bearer token. Default:
   *  MEANDER_VALTOWN_TOKEN_ENV or VALTOWN_TOKEN. */
  tokenEnv?: string | undefined
  /** When true, missing token / password log a warning and
   *  return 0 instead of throwing. Used by CI workflows that
   *  shouldn't fail just because the publish secret isn't
   *  provisioned (e.g. fork PRs). */
  graceful?: boolean | undefined
}

async function uploadBlob(
  token: string,
  key: string,
  content: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/blob/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: content,
  })
  if (!res.ok) {
    throw new Error(
      `Failed to upload blob ${key}: ${res.status} ${await res.text()}`,
    )
  }
  console.log(`  Uploaded: ${key}`)
}

function encryptHtml(html: string, key: Buffer): string {
  return encrypt(html, key)
}

export async function publish(
  configPath: string,
  options: PublishOptions = { __proto__: null } as PublishOptions,
): Promise<void> {
  const { tokenEnv, graceful = false } = {
    __proto__: null,
    ...options,
  } as PublishOptions

  const { envName, token } = resolveValTownToken(tokenEnv)
  if (!token) {
    const msg = missingTokenMessage(envName)
    if (graceful) {
      console.log(`[publish] skipped — ${msg}`)
      return
    }
    throw new Error(msg)
  }

  const password = process.env['MEANDER_ENCRYPTION_KEY']
  if (!password) {
    const msg =
      'MEANDER_ENCRYPTION_KEY environment variable is required for publish (derives the AES-256-GCM key that encrypts walkthrough content at rest).'
    if (graceful) {
      console.log(`[publish] skipped — ${msg}`)
      return
    }
    throw new Error(msg)
  }

  const key = deriveKey(password)
  const resolved = path.resolve(configPath)
  const config = JSON.parse(readFileSync(resolved, 'utf-8'))
  const slug: string = config.slug
  if (!slug) {
    throw new Error("meander.config.json must have a 'slug' field")
  }

  /* outDir is the shared prefix both local emit + Val Town blob
   * keys use. Default "pages"; consumer can override via
   * meander.config.json. Must match what deploy-val set as the
   * val's MEANDER_OUT_DIR env var — otherwise the val looks in
   * the wrong prefix and serves 404s. The val has a backward-
   * compat read that falls back to "walkthrough/" when the
   * new prefix misses, so a consumer mid-rename doesn't go
   * dark. */
  const outDirName =
    typeof config.outDir === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(config.outDir)
      ? config.outDir
      : 'pages'

  const configDir = path.join(resolved, '..')
  const localOutDir = path.join(configDir, outDirName)
  const parts: Array<{ id: number }> = config.parts

  console.log(
    `Publishing walkthrough "${slug}" from ${localOutDir} → blob prefix "${outDirName}/" (${parts.length} parts)...`,
  )

  // Upload shared CSS
  const css = readFileSync(path.join(localOutDir, 'meander.css'), 'utf-8')
  await uploadBlob(token, `${outDirName}/meander.css`, css)

  // Upload index.html (encrypted)
  const indexHtml = readFileSync(path.join(localOutDir, 'index.html'), 'utf-8')
  await uploadBlob(
    token,
    `${outDirName}/${slug}/index.html`,
    encryptHtml(indexHtml, key),
  )

  // Upload part HTML files (encrypted)
  for (const part of parts) {
    const filename = `part-${part.id}.html`
    const html = readFileSync(path.join(localOutDir, filename), 'utf-8')
    await uploadBlob(
      token,
      `${outDirName}/${slug}/${filename}`,
      encryptHtml(html, key),
    )
  }

  // Upload documents.html if present (encrypted)
  const documentsPath = path.join(localOutDir, 'documents.html')
  let hasDocuments = false
  if (existsSync(documentsPath)) {
    const documentsHtml = readFileSync(documentsPath, 'utf-8')
    await uploadBlob(
      token,
      `${outDirName}/${slug}/documents.html`,
      encryptHtml(documentsHtml, key),
    )
    hasDocuments = true
  }

  // Upload manifest
  const manifest = readFileSync(
    path.join(localOutDir, 'manifest.json'),
    'utf-8',
  )
  await uploadBlob(token, `${outDirName}/${slug}/manifest.json`, manifest)

  const fileCount = parts.length + 2 + (hasDocuments ? 1 : 0)
  console.log(`\nDone! Published ${fileCount} files for "${slug}".`)
}
