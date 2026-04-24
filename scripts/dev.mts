/**
 * Local dev entry: generate + serve the test fixture, with
 * optional file-watcher that re-runs generate on source change.
 *
 * Invoked via `pnpm dev` — serve-only by default, `--watch`
 * adds the file watcher. The watcher uses Node's `fs.watch`
 * across three scopes:
 *
 *   - the fixture dir (source files referenced by parts + docs)
 *   - walkthrough.json itself (config changes)
 *   - assets/ (CSS + client-side JS bundled into the emit)
 *
 * Events are debounced so a multi-file save (IDE formatters,
 * git checkouts) triggers a single regen, not one per file.
 */
import path from "node:path";
import { watch as fsWatch } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { generate } from "../src/generate.mts";
import { serve } from "../src/serve.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixtureDir = path.join(repoRoot, "test-walkthrough-docs");
const assetsDir = path.join(repoRoot, "assets");
const configPath = path.join(fixtureDir, "walkthrough.json");

const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.slice("--port=".length)) : 8080;
const watchMode = process.argv.includes("--watch");

await generate(configPath, { __proto__: null } as { __proto__: null });

if (watchMode) {
  /* Fire-and-forget watcher — the serve() call below blocks
   * forever on its HTTP listener, so this promise is a
   * long-running sidecar. Any error escaping regenerate() is
   * logged + swallowed so a single bad save doesn't kill the
   * dev loop. */
  void startWatcher();
}

await serve(configPath, { port, __proto__: null } as { port: number; __proto__: null });

async function startWatcher(): Promise<void> {
  /* Debounce window. Save-on-format triggers a burst of events
   * within ~50ms; 150ms catches them all while still feeling
   * live. Tune up if you see duplicate regens. */
  const DEBOUNCE_MS = 150;
  let pending = false;
  let timer: NodeJS.Timeout | null = null;
  const kick = (reason: string): void => {
    if (timer) {
      clearTimeout(timer);
    }
    pending = true;
    timer = setTimeout(() => {
      if (!pending) {
        return;
      }
      pending = false;
      timer = null;
      const started = Date.now();
      generate(configPath, { __proto__: null } as { __proto__: null })
        .then(() => {
          console.log(
            `✓ regen (${reason}) in ${Date.now() - started}ms`,
          );
        })
        .catch((e: unknown) => {
          console.error(`✗ regen failed (${reason}):`, e);
        });
    }, DEBOUNCE_MS);
  };

  /* Three independent watchers, each on its own scope. We
   * ignore the emit dir (walkthrough/) explicitly by checking
   * path prefixes — writes from our own generate() would
   * otherwise trigger an infinite regen loop. */
  const outDirName = "walkthrough";
  const watchOne = async (dir: string, reason: string): Promise<void> => {
    try {
      const watcher = fsWatch(dir, { recursive: true });
      for await (const event of watcher) {
        const name = event.filename ?? "";
        if (name.startsWith(outDirName + path.sep) || name === outDirName) {
          continue;
        }
        kick(`${reason}: ${name || "?"}`);
      }
    } catch (e) {
      console.error(`watcher ${reason} stopped:`, e);
    }
  };

  console.log("→ watch: fixture sources + walkthrough.json + assets/");
  /* Watchers are long-running loops; if one throws we still
   * want the other polling, so settle rather than all. Errors
   * are already logged inside watchOne. */
  await Promise.allSettled([
    watchOne(fixtureDir, "fixture"),
    watchOne(assetsDir, "assets"),
  ]);
}
