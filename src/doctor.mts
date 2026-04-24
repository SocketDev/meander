/**
 * Diagnostic command: `meander doctor` reports system info +
 * resolves the optional peer deps that gate feature flags
 * (mermaid → puppeteer/mermaid/svgo; minify → esbuild/svgo).
 *
 * When a peer dep is missing, the feature it enables silently
 * no-ops at build time. `doctor` surfaces those gaps up front
 * so a consumer who set `{ "mermaid": true }` in
 * walkthrough.json doesn't get a confusing runtime error when
 * the generator can't find puppeteer.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PeerStatus = {
  name: string;
  required: string;
  resolved: string | null;
  description: string;
};

/** Resolve a peer dep via `require.resolve` from the caller's
 *  cwd. Returns the resolved version or `null` if not found.
 *
 *  Two-step: first confirm the package is resolvable via its
 *  main entry (some packages — svgo, puppeteer — have strict
 *  `exports` maps that reject `./package.json`), then walk up
 *  from the main entry to find package.json on disk and read
 *  its version. */
async function resolvePeer(name: string): Promise<string | null> {
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(path.join(process.cwd(), "package.json"));
    let entryPath: string;
    try {
      entryPath = req.resolve(name);
    } catch {
      return null;
    }
    /* Walk up directories from the resolved entry until we hit
     * a package.json whose `name` matches. Handles nested
     * node_modules + workspace links without depending on the
     * package's own `exports`. */
    let dir = path.dirname(entryPath);
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, "package.json");
      if (existsSync(candidate)) {
        try {
          const meta = JSON.parse(readFileSync(candidate, "utf-8")) as {
            name?: string;
            version?: string;
          };
          if (meta.name === name) {
            return meta.version ?? "unknown";
          }
        } catch {
          /* malformed package.json — keep walking */
        }
      }
      dir = path.dirname(dir);
    }
    return "unknown";
  } catch {
    return null;
  }
}

/** Self-resolve meander's own version so the report shows
 *  which install this doctor is speaking for. Reads the
 *  bundled package.json one level above the compiled output
 *  (dist/doctor.js) or the source (src/doctor.mts). */
function getMeanderVersion(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const candidates = [
    path.join(path.dirname(thisFile), "..", "package.json"),
    path.join(path.dirname(thisFile), "..", "..", "package.json"),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) {
      continue;
    }
    try {
      const meta = JSON.parse(readFileSync(c, "utf-8")) as {
        name?: string;
        version?: string;
      };
      /* Only trust the result when the name matches — a parent
       * package.json in a monorepo checkout would still parse. */
      if (meta.name === "@divmain/meander" && meta.version) {
        return meta.version;
      }
    } catch {
      /* malformed JSON — try the next candidate */
    }
  }
  return "unknown";
}

export async function doctor(): Promise<void> {
  console.log("meander doctor");
  console.log(`  platform: ${process.platform}-${process.arch}`);
  console.log(`  node:     ${process.version}`);
  console.log(`  meander:  ${getMeanderVersion()}`);
  console.log(`  cwd:      ${process.cwd()}`);
  console.log("");
  console.log("Optional peer dependencies");
  console.log("  (only needed when the feature they gate is enabled)");
  console.log("");

  const peers: Array<Omit<PeerStatus, "resolved">> = [
    {
      name: "mermaid",
      required: ">=11",
      description: "Render ```mermaid fenced blocks to SVG at build time",
    },
    {
      name: "puppeteer",
      required: ">=23",
      description: "Headless Chrome used by the mermaid renderer",
    },
    {
      name: "svgo",
      required: ">=4",
      description: "Shrink mermaid SVGs + inline <svg> in emitted HTML",
    },
    {
      name: "esbuild",
      required: ">=0.25",
      description: "Minify inline <script> + walkthrough.css + sw.js",
    },
  ];

  const results: PeerStatus[] = await Promise.all(
    peers.map(async (p) => ({
      ...p,
      resolved: await resolvePeer(p.name),
    })),
  );

  const nameWidth = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const marker = r.resolved ? "✓" : "✗";
    const pad = r.name.padEnd(nameWidth);
    const version = r.resolved
      ? r.resolved
      : `not installed (need ${r.required})`;
    console.log(`  ${marker} ${pad}  ${version}`);
    console.log(`    ${r.description}`);
  }

  const missing = results.filter((r) => !r.resolved);
  console.log("");
  if (missing.length === 0) {
    console.log("All optional peers resolved.");
    return;
  }
  console.log(
    `${missing.length} optional peer(s) missing. Features requiring them ` +
      `silently no-op; install with:`,
  );
  console.log("");
  console.log(`  pnpm add -D ${missing.map((p) => p.name).join(" ")}`);
}
