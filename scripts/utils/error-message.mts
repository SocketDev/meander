/**
 * @fileoverview Re-export of the shared `errorMessage` helper.
 *
 * `@socketsecurity/lib/errors` walks the `cause` chain, coerces primitives,
 * and returns the shared `UNKNOWN_ERROR` sentinel for null/undefined/empty.
 * Scripts use this — src/ has its own primordial-guarded helpers.
 */

export { errorMessage } from '@socketsecurity/lib/errors'
