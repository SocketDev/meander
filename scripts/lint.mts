/**
 * Lint: runs oxlint across the source tree.
 * `pnpm lint` — CI-friendly, non-mutating.
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("pnpm", ["exec", "oxlint", "src", "scripts"], { stdio: "inherit" });
process.exit(result.status ?? 1);
