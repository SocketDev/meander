/**
 * Check: lint + type-check + schema-validation gate. Runs in
 * CI to block merges; also the pre-commit sanity command.
 *
 * Uses @socketsecurity/lib/spawn for async process management.
 * Inherited stdio keeps live output identical to a direct
 * `node <script>` invocation. On any step's non-zero exit we
 * set process.exitCode + return — letting Node flush pending
 * writes before the process terminates (which process.exit()
 * can cut short).
 */
import { spawn } from '@socketsecurity/lib/spawn'

async function run(
  cmd: string,
  args: string[],
  label: string,
): Promise<boolean> {
  console.log(`→ ${label}`)
  try {
    await spawn(cmd, args, { stdio: 'inherit' })
    return true
  } catch (e) {
    console.error(`✗ ${label} failed`)
    process.exitCode = (e as { code?: number }).code ?? 1
    return false
  }
}

const steps: Array<[string, string[], string]> = [
  ['pnpm', ['exec', 'oxlint', 'src', 'scripts'], 'lint'],
  ['pnpm', ['exec', 'tsc', '--noEmit'], 'type-check'],
  ['node', ['scripts/validate-tools.mts'], 'validate external-tools.json'],
]

for (const [cmd, args, label] of steps) {
  if (!(await run(cmd, args, label))) {
    /* Stop on first failure — downstream steps often depend on
     * earlier ones (validate-tools runs node, which depends on
     * a clean install; a lint failure usually flags something
     * that would break the typecheck anyway). */
    break
  }
}

if (!process.exitCode) {
  console.log('✓ all checks passed')
}
