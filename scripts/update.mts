/**
 * Update: taze bumps every dep to its latest compatible version
 * (respecting semver ranges in package.json). Because we pin all
 * deps to exact versions, taze rewrites each pinned version to
 * the latest one and reinstalls.
 *
 * `pnpm update` — runs taze + pnpm install to refresh lockfile.
 * Review the diff before committing.
 */
import { spawnSync } from "node:child_process";

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

/* -w writes changes to package.json; without it taze only prints.
 * -f forces exact-version pins (no caret/tilde prefixes) — matches
 * our pin policy. */
run("pnpm", ["exec", "taze", "-w", "-f"]);
run("pnpm", ["install"]);
