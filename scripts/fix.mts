/**
 * Fix: oxfmt (formatter) + oxlint --fix (rule auto-fixes).
 * `pnpm fix` — mutates files in place; commit the diff.
 *
 * Fmt first, then lint-fix: formatter normalises layout, and
 * some lint fixes need well-formatted input to apply cleanly.
 */
import { spawn } from '@socketsecurity/lib/spawn'

async function run(cmd: string, args: string[]): Promise<boolean> {
  try {
    await spawn(cmd, args, { stdio: 'inherit' })
    return true
  } catch (e) {
    process.exitCode = (e as { code?: number }).code ?? 1
    return false
  }
}

for (const [cmd, args] of [
  ['pnpm', ['exec', 'oxfmt', 'assets', 'src', 'scripts']],
  ['pnpm', ['exec', 'oxlint', '--fix', 'assets', 'src', 'scripts']],
] as const) {
  if (!(await run(cmd, [...args]))) {
    break
  }
}
