/**
 * Update: taze bumps every dep to the latest compatible version.
 * Config lives in .config/taze.config.mts — key policy bits:
 *   - maturityPeriod: 7  (skip versions released in the last 7 days;
 *                         matches the fleet-wide cooldown to avoid
 *                         adopting compromised or broken releases
 *                         before the ecosystem catches them)
 *   - mode: 'latest'     (bump to latest across major boundaries)
 *   - write: true        (edit package.json in place)
 *
 * `pnpm update` — runs taze + pnpm install to refresh the lockfile.
 * Review the diff before committing.
 */
import { spawnSync } from "node:child_process";

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("pnpm", ["exec", "taze"]);
run("pnpm", ["install"]);
