/**
 * Lint: runs oxlint across the source tree.
 * `pnpm lint` — CI-friendly, non-mutating.
 */
import { spawn } from '@socketsecurity/lib/spawn'

try {
  await spawn('pnpm', ['exec', 'oxlint', 'src', 'scripts'], {
    stdio: 'inherit',
  })
} catch (e) {
  /* process.exitCode flushes pending writes before Node exits,
   * where process.exit() would cut them short. */
  process.exitCode = (e as { code?: number }).code ?? 1
}
