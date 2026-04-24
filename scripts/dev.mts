/**
 * Local dev entry: generate + serve the test fixture.
 *
 * Invoked via `pnpm dev`. Calls the CLI's `serve` command
 * pointing at `test-walkthrough-docs/walkthrough.json`. The
 * `serve` command treats the dir containing the config as the
 * project root, so no `cd` is needed.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { generate } from "../src/generate.mts";
import { serve } from "../src/serve.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixtureDir = path.join(repoRoot, "test-walkthrough-docs");
const configPath = path.join(fixtureDir, "walkthrough.json");

const portArg = process.argv.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.slice("--port=".length)) : 8080;

await generate(configPath, { __proto__: null } as { __proto__: null });
await serve(configPath, { port, __proto__: null } as { port: number; __proto__: null });
