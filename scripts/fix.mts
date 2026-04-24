/**
 * Fix: oxfmt (formatter) + oxlint --fix (rule auto-fixes).
 * `pnpm fix` — mutates files in place; commit the diff.
 *
 * Fmt first, then lint-fix: formatter normalises layout, and
 * some lint fixes need well-formatted input to apply cleanly.
 */
import { spawnSync } from "node:child_process";

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["exec", "oxfmt", "src", "scripts"]);
run("pnpm", ["exec", "oxlint", "--fix", "src", "scripts"]);
