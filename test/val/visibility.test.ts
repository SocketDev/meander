/**
 * @file Coverage for the val's walkthrough-visibility record
 *   (assets/val/lib/visibility.ts) — the blob oracle, the recorded
 *   flag, and the derive-on-unknown path that carries a deployment
 *   published before the table existed.
 *   The whole point of the module is which way it fails, so the
 *   fail-closed cases (no row and no blob, no row and a probe that
 *   throws) get as much attention as the happy path.
 */

import { describe, expect, it } from 'vitest'

import {
  encrypt,
  importKey,
  packEnvelope,
  randomDataKeyBytes,
  wrapKey,
} from '../../assets/repo/val/lib/crypto.ts'
import {
  blobTextIsEncrypted,
  probeSlugPrivacy,
  readRecordedSlugPrivacy,
  recordSlugPrivacy,
  resolveSlugPrivacy,
  WALKTHROUGH_VISIBILITY_TABLE_SQL,
} from '../../assets/repo/val/lib/visibility.ts'

const BLOB_KEY_BYTES = new Uint8Array(32).fill(0x3c)

/**
 * The `walkthrough_visibility` table, small enough to read the SQL
 * it is handed rather than assume a shape. A statement that queries
 * some other table returns nothing, so a handler that forgets the
 * table name goes red instead of silently matching.
 */
class FakeVisibilityDb {
  readonly rows = new Map<string, number>()
  readonly statements: string[] = []

  async execute(
    arg: string | { sql: string; args?: Record<string, unknown> | undefined },
  ): Promise<{ rows: readonly unknown[] }> {
    const sql = typeof arg === 'string' ? arg : arg.sql
    const args = typeof arg === 'string' ? {} : (arg.args ?? {})
    this.statements.push(sql)
    if (!sql.includes('walkthrough_visibility')) {
      return { rows: [] }
    }
    const slug = String(args['slug'])
    if (sql.startsWith('SELECT')) {
      const recorded = this.rows.get(slug)
      return { rows: recorded === undefined ? [] : [{ is_private: recorded }] }
    }
    if (sql.startsWith('INSERT')) {
      this.rows.set(slug, Number(args['isPrivate']))
    }
    return { rows: [] }
  }
}

async function sealedBlob(html: string): Promise<string> {
  const wrapping = await importKey(BLOB_KEY_BYTES)
  const dekBytes = randomDataKeyBytes()
  const dek = await importKey(dekBytes)
  return packEnvelope(
    await encrypt(html, dek),
    await wrapKey(dekBytes, wrapping),
  )
}

/* ------------------------------------------------------------------ */
/*  The blob oracle                                                     */
/* ------------------------------------------------------------------ */

describe('blobTextIsEncrypted', () => {
  it('reads plaintext HTML as public', () => {
    expect(blobTextIsEncrypted('<html>hello</html>')).toBe(false)
  })

  it('reads a real envelope as private', async () => {
    expect(blobTextIsEncrypted(await sealedBlob('<html>secret</html>'))).toBe(
      true,
    )
  })

  it('reads a malformed envelope as private', () => {
    expect(blobTextIsEncrypted('ENVELOPE:9:only-three:parts:extra')).toBe(true)
  })
})

describe('probeSlugPrivacy', () => {
  it('probes the walkthrough index page', async () => {
    const seen: string[] = []
    await probeSlugPrivacy(async key => {
      seen.push(key)
      return '<html>public</html>'
    }, 'alpha')
    expect(seen).toEqual(['alpha/index.html'])
  })

  it('answers public for a plaintext index', async () => {
    expect(
      await probeSlugPrivacy(async () => '<html>public</html>', 'alpha'),
    ).toBe(false)
  })

  it('answers private for an encrypted index', async () => {
    const sealed = await sealedBlob('<html>secret</html>')
    expect(await probeSlugPrivacy(async () => sealed, 'alpha')).toBe(true)
  })

  it('answers private when the blob is absent', async () => {
    expect(await probeSlugPrivacy(async () => undefined, 'ghost')).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  The recorded flag                                                   */
/* ------------------------------------------------------------------ */

describe('recordSlugPrivacy', () => {
  it('records a private walkthrough', async () => {
    const db = new FakeVisibilityDb()
    await recordSlugPrivacy(db, { slug: 'alpha', isPrivate: true })
    expect(db.rows.get('alpha')).toBe(1)
  })

  it('replaces an earlier record', async () => {
    const db = new FakeVisibilityDb()
    await recordSlugPrivacy(db, { slug: 'alpha', isPrivate: true })
    await recordSlugPrivacy(db, { slug: 'alpha', isPrivate: false })
    expect(db.rows.get('alpha')).toBe(0)
  })

  it('scopes the record to its own slug', async () => {
    const db = new FakeVisibilityDb()
    await recordSlugPrivacy(db, { slug: 'alpha', isPrivate: true })
    await recordSlugPrivacy(db, { slug: 'beta', isPrivate: false })
    expect(db.rows.get('alpha')).toBe(1)
    expect(db.rows.get('beta')).toBe(0)
  })
})

describe('readRecordedSlugPrivacy', () => {
  it('answers undefined for a slug nobody recorded', async () => {
    const db = new FakeVisibilityDb()
    expect(await readRecordedSlugPrivacy(db, 'alpha')).toBe(undefined)
  })

  it('reads back both recorded states', async () => {
    const db = new FakeVisibilityDb()
    await recordSlugPrivacy(db, { slug: 'alpha', isPrivate: true })
    await recordSlugPrivacy(db, { slug: 'beta', isPrivate: false })
    expect(await readRecordedSlugPrivacy(db, 'alpha')).toBe(true)
    expect(await readRecordedSlugPrivacy(db, 'beta')).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/*  Resolving                                                           */
/* ------------------------------------------------------------------ */

describe('resolveSlugPrivacy', () => {
  it('answers from the record without probing', async () => {
    const db = new FakeVisibilityDb()
    await recordSlugPrivacy(db, { slug: 'alpha', isPrivate: true })
    let probes = 0
    const answer = await resolveSlugPrivacy(db, 'alpha', async () => {
      probes += 1
      return false
    })
    expect(answer).toBe(true)
    expect(probes).toBe(0)
  })

  it('trusts a recorded public walkthrough without probing', async () => {
    const db = new FakeVisibilityDb()
    await recordSlugPrivacy(db, { slug: 'alpha', isPrivate: false })
    let probes = 0
    const answer = await resolveSlugPrivacy(db, 'alpha', async () => {
      probes += 1
      return true
    })
    expect(answer).toBe(false)
    expect(probes).toBe(0)
  })

  it('derives and persists an unrecorded slug', async () => {
    const db = new FakeVisibilityDb()
    expect(await resolveSlugPrivacy(db, 'alpha', async () => true)).toBe(true)
    expect(db.rows.get('alpha')).toBe(1)
  })

  it('pays the derivation once per slug', async () => {
    const db = new FakeVisibilityDb()
    let probes = 0
    const probe = async () => {
      probes += 1
      return false
    }
    await resolveSlugPrivacy(db, 'alpha', probe)
    await resolveSlugPrivacy(db, 'alpha', probe)
    await resolveSlugPrivacy(db, 'alpha', probe)
    expect(probes).toBe(1)
  })

  it('answers private when the probe throws', async () => {
    const db = new FakeVisibilityDb()
    const answer = await resolveSlugPrivacy(db, 'alpha', async () => {
      throw new Error('blob store unreachable')
    })
    expect(answer).toBe(true)
  })

  it('records nothing when the probe throws', async () => {
    const db = new FakeVisibilityDb()
    await resolveSlugPrivacy(db, 'alpha', async () => {
      throw new Error('blob store unreachable')
    })
    expect(db.rows.has('alpha')).toBe(false)
  })

  it('re-derives once the blob store recovers', async () => {
    const db = new FakeVisibilityDb()
    let healthy = false
    const probe = async () => {
      if (!healthy) {
        throw new Error('blob store unreachable')
      }
      return false
    }
    expect(await resolveSlugPrivacy(db, 'alpha', probe)).toBe(true)
    healthy = true
    expect(await resolveSlugPrivacy(db, 'alpha', probe)).toBe(false)
  })
})

describe('WALKTHROUGH_VISIBILITY_TABLE_SQL', () => {
  it('creates the table only when it is absent', () => {
    expect(WALKTHROUGH_VISIBILITY_TABLE_SQL).toContain(
      'CREATE TABLE IF NOT EXISTS walkthrough_visibility',
    )
  })

  it('keys the table by slug so a lookup is an index seek', () => {
    expect(WALKTHROUGH_VISIBILITY_TABLE_SQL).toContain(
      'slug         TEXT PRIMARY KEY',
    )
  })
})
