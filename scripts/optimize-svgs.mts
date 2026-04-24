/**
 * Optimize bundled SVGs via svgo. Covers assets/logo/*.svg and
 * assets/favicon/*.svg — the SVGs meander ships with the npm
 * package. Edits files in place; review `git diff` before
 * committing.
 *
 * `pnpm optimize-svgs` — runs the whole sweep.
 *
 * Uses svgo's default preset plus a few tuned overrides:
 *   - preserve viewBox (critical for our bezel layering + favicon crop)
 *   - keep role / aria-label (a11y)
 *   - drop raw/inline doctype, xml decl, editor metadata
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optimize, type Config } from "svgo";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const targets = [
  "assets/logo/logo-black.svg",
  "assets/logo/logo-bezel-light.svg",
  "assets/logo/logo-bezel-dark.svg",
  "assets/logo/logo-mark.svg",
  "assets/favicon/favicon.svg",
];

const config: Config = {
  multipass: true,
  plugins: [
    "preset-default",
    /* Inkscape writes xmlns:inkscape, xmlns:sodipodi, and a
     * <sodipodi:namedview> element. None of them affect the
     * rendered output; they're just the editor's state. */
    {
      name: "removeAttrs",
      params: { attrs: "(inkscape|sodipodi):\\w+" },
    },
  ],
};

/* svgo's `removeXMLNS` is NOT in preset-default, but the SVG
 * spec technically allows SVGs without xmlns when embedded in
 * an HTML document. We need xmlns for standalone <img src>
 * use and for favicon browser fetches. svgo strips it in some
 * code paths — re-inject if missing. */
function ensureXmlns(svg: string): string {
  if (/\sxmlns\s*=/.test(svg)) {
    return svg;
  }
  return svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
}

let totalBefore = 0;
let totalAfter = 0;
for (const rel of targets) {
  const full = path.join(repoRoot, rel);
  const before = readFileSync(full, "utf-8");
  const out = optimize(before, { ...config, path: full });
  const after = ensureXmlns(out.data);
  totalBefore += before.length;
  totalAfter += after.length;
  writeFileSync(full, after);
  const pct = Math.round((1 - after.length / before.length) * 100);
  console.log(`  ${rel}: ${before.length} → ${after.length} bytes (${pct}% smaller)`);
}
const pctTotal = Math.round((1 - totalAfter / totalBefore) * 100);
console.log(`\ntotal: ${totalBefore} → ${totalAfter} bytes (${pctTotal}% smaller)`);
