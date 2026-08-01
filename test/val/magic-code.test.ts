/**
 * @file Tests for assets/val/lib/magic-code.ts. Two sign-in routes share this
 *   code path now — the comment-API session and an encrypted walkthrough's
 *   reader cookie — so the one-shot delete, the expiry, and the attempt
 *   ceiling are pinned here once rather than per route. The sqlite stand-in
 *   below holds a single row and answers the three statements the module
 *   issues.
 */

import { describe, expect, it } from 'vitest'

import type { SqliteClient } from '../../assets/val/lib/admin.ts'
import { hashCode } from '../../assets/val/lib/auth.ts'
import {
  consumeMagicCode,
  MAGIC_CODE_MAX_ATTEMPTS,
  storeMagicCode,
} from '../../assets/val/lib/magic-code.ts'

const EMAIL = 'a@socket.dev'
const CODE = '424242'

type CodeRow = {
  email: string
  code_hash: string
  expires_at: number
  attempts: number
}

/**
 * In-memory `magic_codes` table. Only the statements
 * `lib/magic-code.ts` issues are implemented; anything else throws
 * so a changed query cannot pass silently.
 */
function makeCodeStore(initial?: CodeRow | undefined) {
  let row = initial
  const sqlite: SqliteClient & { row: () => CodeRow | undefined } = {
    row: () => (row ? { ...row } : undefined),
    async execute(arg) {
      const raw = typeof arg === 'string' ? arg : arg.sql
      const args = typeof arg === 'string' ? {} : (arg.args ?? {})
      const sql = raw.replace(/\s+/g, ' ').trim()
      if (sql.startsWith('SELECT code_hash, expires_at, attempts')) {
        return { rows: row && row.email === args['email'] ? [row] : [] }
      }
      if (sql.startsWith('UPDATE magic_codes SET attempts')) {
        if (row) {
          row = { ...row, attempts: row.attempts + 1 }
        }
        return { rows: [] }
      }
      if (sql.startsWith('DELETE FROM magic_codes')) {
        row = undefined
        return { rows: [] }
      }
      if (sql.startsWith('INSERT INTO magic_codes')) {
        row = {
          email: String(args['email']),
          code_hash: String(args['codeHash']),
          expires_at: Number(args['expiresAt']),
          attempts: 0,
        }
        return { rows: [] }
      }
      throw new Error(`unhandled SQL: ${sql}`)
    },
  }
  return sqlite
}

async function liveRow(attempts = 0): Promise<CodeRow> {
  return {
    email: EMAIL,
    code_hash: await hashCode(CODE, EMAIL),
    expires_at: Math.floor(Date.now() / 1000) + 600,
    attempts,
  }
}

describe('consumeMagicCode', () => {
  it('accepts the right code and burns it', async () => {
    const sqlite = makeCodeStore(await liveRow())
    expect(await consumeMagicCode(sqlite, EMAIL, CODE)).toEqual({ ok: true })
    expect(sqlite.row()).toBeUndefined()
  })

  it('refuses a second use of the same code', async () => {
    const sqlite = makeCodeStore(await liveRow())
    await consumeMagicCode(sqlite, EMAIL, CODE)
    expect(await consumeMagicCode(sqlite, EMAIL, CODE)).toEqual({
      ok: false,
      error: 'no code for this email',
      status: 400,
    })
  })

  it('refuses when no code was ever requested', async () => {
    const sqlite = makeCodeStore()
    const outcome = await consumeMagicCode(sqlite, EMAIL, CODE)
    expect(outcome).toEqual({
      ok: false,
      error: 'no code for this email',
      status: 400,
    })
  })

  it('refuses an expired code without burning it', async () => {
    const stale = await liveRow()
    stale.expires_at = Math.floor(Date.now() / 1000) - 1
    const sqlite = makeCodeStore(stale)
    expect(await consumeMagicCode(sqlite, EMAIL, CODE)).toEqual({
      ok: false,
      error: 'code expired',
      status: 400,
    })
  })

  it('counts a wrong guess instead of deleting the row', async () => {
    const sqlite = makeCodeStore(await liveRow())
    expect(await consumeMagicCode(sqlite, EMAIL, '000000')).toEqual({
      ok: false,
      error: 'invalid code',
      status: 401,
    })
    expect(sqlite.row()?.attempts).toBe(1)
  })

  it('stops answering once the attempt ceiling is reached', async () => {
    const sqlite = makeCodeStore(await liveRow(MAGIC_CODE_MAX_ATTEMPTS))
    expect(await consumeMagicCode(sqlite, EMAIL, CODE)).toEqual({
      ok: false,
      error: 'too many attempts; request a new code',
      status: 429,
    })
  })

  it('refuses a code minted for a different email', async () => {
    const sqlite = makeCodeStore(await liveRow())
    const outcome = await consumeMagicCode(sqlite, 'b@socket.dev', CODE)
    expect(outcome).toEqual({
      ok: false,
      error: 'no code for this email',
      status: 400,
    })
  })
})

describe('storeMagicCode', () => {
  it('replaces a locked-out row and resets the attempt counter', async () => {
    const sqlite = makeCodeStore(await liveRow(MAGIC_CODE_MAX_ATTEMPTS))
    const expiresAt = Math.floor(Date.now() / 1000) + 600
    await storeMagicCode(
      sqlite,
      EMAIL,
      await hashCode('999999', EMAIL),
      expiresAt,
    )
    expect(sqlite.row()?.attempts).toBe(0)
    expect(await consumeMagicCode(sqlite, EMAIL, '999999')).toEqual({
      ok: true,
    })
  })
})
