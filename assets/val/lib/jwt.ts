/**
 * HS256 JWT helpers. Pure — runs under Deno (val) and Node
 * (tests) identically via Web Crypto.
 */

export function b64urlDecode(s: string): Uint8Array {
  const padded = s.replaceAll('-', '+').replaceAll('_', '/')
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  return new Uint8Array(
    atob(padded + pad)
      .split('')
      .map(c => c.charCodeAt(0)),
  )
}

export function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/**
 * Mint an HS256 JWT with an arbitrary payload. Callers pass
 * `{ email, exp }` — any serializable shape works. Returns the
 * compact JWS form `head.body.sig` (base64url-encoded parts).
 */
export async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const encode = (o: object) =>
    b64urlEncode(new TextEncoder().encode(JSON.stringify(o)))
  const head = encode(header)
  const body = encode(payload)
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${head}.${body}`),
  )
  return `${head}.${body}.${b64urlEncode(new Uint8Array(sig))}`
}

/**
 * Verify a JWT. Returns the decoded payload on success or
 * undefined (bad signature, expired, malformed). `now` is
 * injectable so tests can drive clock-skew scenarios.
 */
export async function verifyJwt(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Record<string, unknown> | undefined> {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return undefined
  }
  const [head, body, sig] = parts as [string, string, string]
  const key = await hmacKey(secret)
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    b64urlDecode(sig),
    new TextEncoder().encode(`${head}.${body}`),
  )
  if (!ok) {
    return undefined
  }
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(body)),
    ) as Record<string, unknown>
    if (typeof payload['exp'] === 'number' && payload['exp'] < now) {
      return undefined
    }
    return payload
  } catch {
    return undefined
  }
}
