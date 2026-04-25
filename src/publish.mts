import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { encrypt, packEnvelope, randomDataKey, wrapKey } from './crypto.mts'
import { missingTokenMessage, resolveValTownToken } from './valtown-token.mts'

const API_BASE = 'https://api.val.town'

export type PublishOptions = {
  /** Override the env var read for the bearer token. Default:
   *  MEANDER_VALTOWN_TOKEN_ENV or VALTOWN_TOKEN. */
  tokenEnv?: string | undefined
  /** When true, missing token / blob key log a warning and
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

/**
 * Decode a 32-byte blob wrapping key from its env-var form. We
 * accept hex (64 chars) — easy to print, easy to paste, no padding
 * ambiguity. The shape check below is the only validation; if a
 * caller supplies the wrong length, AES-256-GCM rejects later with
 * a clear error, which is fine for ops debugging.
 */
function loadBlobWrappingKey(): Buffer | undefined {
  const hex = process.env['MEANDER_BLOB_KEY']
  if (!hex) {
    return undefined
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'MEANDER_BLOB_KEY must be 64 hex characters (32 bytes). Generate one with `meander blob key init`.',
    )
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Encrypt a single HTML payload using the envelope scheme:
 *   1. Random per-blob DEK.
 *   2. Body ciphertext = AES-256-GCM(DEK, html).
 *   3. wrappedDEK = AES-256-GCM(MEANDER_BLOB_KEY, DEK).
 *   4. Return `ENVELOPE:1:<wrappedDEK>:<body>`.
 */
function encryptBlob(html: string, wrappingKey: Buffer): string {
  const dek = randomDataKey()
  const body = encrypt(html, dek)
  const wrapped = wrapKey(dek, wrappingKey)
  return packEnvelope(body, wrapped)
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

  const resolved = path.resolve(configPath)
  const config = JSON.parse(readFileSync(resolved, 'utf-8'))
  const slug: string = config.slug
  if (!slug) {
    throw new Error("meander.config.json must have a 'slug' field")
  }

  const encryptBlobsEnabled = config.encryptBlobs === true
  let wrappingKey: Buffer | undefined
  if (encryptBlobsEnabled) {
    wrappingKey = loadBlobWrappingKey()
    if (!wrappingKey) {
      const msg =
        'encryptBlobs is true but MEANDER_BLOB_KEY is not set. Generate one with `meander blob key init` and place it in your env.'
      if (graceful) {
        console.log(`[publish] skipped — ${msg}`)
        return
      }
      throw new Error(msg)
    }
  }

  /* outDir is the shared prefix both local emit + Val Town blob
   * keys use. Default "pages"; consumer can override via
   * meander.config.json. Must match what deploy-val set as the
   * val's MEANDER_OUT_DIR env var — otherwise the val looks in
   * the wrong prefix and serves 404s. */
  const outDirName =
    typeof config.outDir === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/.test(config.outDir)
      ? config.outDir
      : 'pages'

  const configDir = path.join(resolved, '..')
  const localOutDir = path.join(configDir, outDirName)
  const parts: Array<{ id: number }> = config.parts

  const mode = encryptBlobsEnabled ? 'envelope-encrypted' : 'plaintext'
  console.log(
    `Publishing walkthrough "${slug}" from ${localOutDir} → blob prefix "${outDirName}/" (${parts.length} parts, ${mode})...`,
  )

  const wrap = (html: string): string =>
    wrappingKey ? encryptBlob(html, wrappingKey) : html

  // Upload shared CSS (always plaintext — browsers can't read encrypted CSS)
  const css = readFileSync(path.join(localOutDir, 'meander.css'), 'utf-8')
  await uploadBlob(token, `${outDirName}/meander.css`, css)

  // Upload index.html
  const indexHtml = readFileSync(path.join(localOutDir, 'index.html'), 'utf-8')
  await uploadBlob(token, `${outDirName}/${slug}/index.html`, wrap(indexHtml))

  // Upload part HTML files
  for (const part of parts) {
    const filename = `part-${part.id}.html`
    const html = readFileSync(path.join(localOutDir, filename), 'utf-8')
    await uploadBlob(token, `${outDirName}/${slug}/${filename}`, wrap(html))
  }

  // Upload documents.html if present
  const documentsPath = path.join(localOutDir, 'documents.html')
  let hasDocuments = false
  if (existsSync(documentsPath)) {
    const documentsHtml = readFileSync(documentsPath, 'utf-8')
    await uploadBlob(
      token,
      `${outDirName}/${slug}/documents.html`,
      wrap(documentsHtml),
    )
    hasDocuments = true
  }

  // Upload manifest (always plaintext — used for build introspection)
  const manifest = readFileSync(
    path.join(localOutDir, 'manifest.json'),
    'utf-8',
  )
  await uploadBlob(token, `${outDirName}/${slug}/manifest.json`, manifest)

  const fileCount = parts.length + 2 + (hasDocuments ? 1 : 0)
  console.log(`\nDone! Published ${fileCount} files for "${slug}".`)
}
