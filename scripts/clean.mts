/**
 * Clean: remove build output + dev fixture artifacts. `pnpm
 * clean` is non-destructive (no source edits), safe to run
 * anytime.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const targets = ["dist", "test-walkthrough-docs/walkthrough"];
for (const t of targets) {
  const full = path.join(repoRoot, t);
  rmSync(full, { recursive: true, force: true });
  console.log(`✓ cleaned ${t}`);
}
