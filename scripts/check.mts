/**
 * Check: lint + type-check gate. `pnpm check` is what CI runs
 * to block merges; it's also the pre-commit sanity command.
 */
import { spawnSync } from "node:child_process";

function run(cmd: string, args: string[], label: string): void {
  console.log(`→ ${label}`);
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    console.error(`✗ ${label} failed`);
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["exec", "oxlint", "src", "scripts"], "lint");
run("pnpm", ["exec", "tsc", "--noEmit"], "type-check");
run(
  "node",
  ["scripts/validate-tools.mts"],
  "validate external-tools.json",
);
console.log("✓ all checks passed");
