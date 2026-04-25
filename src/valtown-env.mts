/**
 * Val Town REST helpers for managing a val's environment variables
 * and finding a val by name. Shared between deploy-val.mts and the
 * `meander db key` / `meander blob key` ceremonies — both need the
 * same primitives: PUT a key, GET a key, DELETE a key, list keys,
 * resolve a val by username + name to its ID + URL.
 *
 * All calls take an explicit Val Town API token (the operator's
 * VALTOWN_TOKEN, val:write scope). None of these functions read
 * the token from process.env directly — keeps the auth boundary
 * visible at the call site.
 */

import ValTown from '@valtown/sdk'

export const API_BASE = 'https://api.val.town'

export type ValHandle = {
  /** Val Town's internal ID for the val. */
  id: string
  /** The val's username (resolved from /me/profile). */
  username: string
  /** The val's HTTPS URL — `https://<username>-<valname>.web.val.run`. */
  url: string
}

/**
 * Look up a val by name under the authenticated user. Throws if the
 * val doesn't exist. Used by ceremonies that operate on an
 * already-deployed val — `deploy-val` is the only command that
 * creates one.
 */
export async function resolveVal(
  token: string,
  valName: string,
): Promise<ValHandle> {
  const client = new ValTown({ bearerToken: token })
  const profile = await client.me.profile.retrieve()
  const username = profile.username ?? ''
  if (!username) {
    throw new Error('Val Town profile has no username — cannot resolve val')
  }
  const val = await client.alias.username.valName.retrieve(username, valName)
  if (!val.id) {
    throw new Error(`Val "${valName}" not found under user "${username}"`)
  }
  return {
    id: val.id,
    username,
    url: val.links?.html ?? `https://${username}-${valName}.web.val.run`,
  }
}

/**
 * Read an env var on the val. Returns undefined if the key isn't
 * set — Val Town's API responds 404 in that case.
 */
export async function getEnvVar(
  token: string,
  valId: string,
  key: string,
): Promise<string | undefined> {
  const res = await fetch(
    `${API_BASE}/v2/vals/${valId}/environment_variables/${key}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status === 404) {
    return undefined
  }
  if (!res.ok) {
    throw new Error(
      `getEnvVar(${key}) failed: ${res.status} ${await res.text()}`,
    )
  }
  const body = (await res.json()) as { value?: string }
  return typeof body.value === 'string' ? body.value : undefined
}

/**
 * Set an env var on the val. PUT first (succeeds if it already
 * exists); fall back to POST (creates a new key). Idempotent
 * either way.
 */
export async function setEnvVar(
  token: string,
  valId: string,
  key: string,
  value: string,
): Promise<void> {
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
    return
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
  if (!createRes.ok) {
    throw new Error(
      `setEnvVar(${key}) failed: ${createRes.status} ${await createRes.text()}`,
    )
  }
}

/**
 * Delete an env var on the val. Used by `db key retire` to remove
 * an old generation that no row references anymore. Returns true
 * if the key existed and was removed, false if it wasn't there to
 * begin with — both outcomes are success from the caller's view.
 */
export async function deleteEnvVar(
  token: string,
  valId: string,
  key: string,
): Promise<boolean> {
  const res = await fetch(
    `${API_BASE}/v2/vals/${valId}/environment_variables/${key}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (res.status === 404) {
    return false
  }
  if (!res.ok) {
    throw new Error(
      `deleteEnvVar(${key}) failed: ${res.status} ${await res.text()}`,
    )
  }
  return true
}

/**
 * List the names of every env var on the val. Used by ceremony
 * commands to find existing MEANDER_DB_KEY_<n> generations
 * without needing to probe each one. Names only — values are
 * fetched separately when needed, so an audit doesn't have to
 * stream the wrapping keys themselves.
 */
export async function listEnvVarNames(
  token: string,
  valId: string,
): Promise<string[]> {
  const res = await fetch(
    `${API_BASE}/v2/vals/${valId}/environment_variables`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    throw new Error(
      `listEnvVarNames failed: ${res.status} ${await res.text()}`,
    )
  }
  const body = (await res.json()) as { data?: Array<{ key?: string }> }
  const out: string[] = []
  for (const entry of body.data ?? []) {
    if (typeof entry.key === 'string') {
      out.push(entry.key)
    }
  }
  return out
}

/**
 * Generate a URL-safe random secret of `bytes` bytes' entropy,
 * base64url-encoded. Used for tokens (admin token, JWT secret)
 * and any other random non-key secrets the val needs.
 */
export function generateSecret(bytes = 32): string {
  /* Lazy node:crypto import keeps this module pure for code paths
   * that only do val-API calls — useful when the same module is
   * pulled in by both Node + tests. */
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let s = ''
  for (let i = 0; i < buf.length; i++) {
    s += String.fromCharCode(buf[i]!)
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
