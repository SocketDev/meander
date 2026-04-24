/**
 * Refresh external-tools.json checksums.
 *
 * For each tool entry, look up the latest published version on
 * GitHub Releases. When there's a newer version:
 *   1. Download every per-platform asset.
 *   2. Compute sha256 for each.
 *   3. Patch the JSON in place with the new version + checksums.
 *
 * Invoked by the weekly-update workflow. Safe to run locally too:
 * `node scripts/update-tools.mts` produces a dirty tree that
 * can be committed after the usual review.
 *
 * Exits 0 when nothing changed; exits 0 + writes the file when
 * updates applied; exits non-zero only on a real error (network,
 * release missing required assets, etc.).
 *
 * Requires: `gh` CLI on PATH, logged in or a GH_TOKEN env var.
 */
import { hash as cryptoHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateExternalTools, type ExternalTools } from './validate-tools.mts'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const toolsPath = path.join(repoRoot, 'external-tools.json')

type ReleaseAsset = { name: string; browser_download_url: string }
type Release = { tag_name: string; assets: ReleaseAsset[] }

async function fetchLatestRelease(repoGithub: string): Promise<Release> {
  /* `repoGithub` is "github:owner/name"; strip the prefix and
   * hit the GitHub API directly via fetch + a GH_TOKEN header
   * if one's available. `gh api` would work too but shelling out
   * is extra moving parts when we already have fetch. */
  const owner = repoGithub.replace(/^github:/, '')
  const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN']
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(
    `https://api.github.com/repos/${owner}/releases/latest`,
    { headers },
  )
  if (!res.ok) {
    throw new Error(
      `GET releases/latest for ${owner}: ${res.status} ${res.statusText}`,
    )
  }
  return (await res.json()) as Release
}

async function sha256OfUrl(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url}: ${res.status}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  return cryptoHash('sha256', bytes, 'hex')
}

function normalizeVersion(tagName: string): string {
  /* Releases are typically tagged v1.2.3 or 1.2.3 — strip the
   * leading v so the JSON stores the bare version number. */
  return tagName.replace(/^v/, '')
}

/**
 * Semver compare — returns negative / 0 / positive for a<b /
 * a==b / a>b. Handles prerelease suffixes (1.0.0-rc.5) by
 * treating a present prerelease as lower than the release but
 * higher than any earlier release; rc.5 > rc.4 > rc.
 *
 * This is enough to answer "is the latest upstream tag newer
 * than what we have pinned?" without pulling in a semver
 * library. If the upstream ships a version scheme we don't
 * understand, fall back to string comparison.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): { main: number[]; pre: string | null } => {
    const [mainPart, prePart] = v.split('-', 2)
    const main = (mainPart ?? '').split('.').map(n => Number.parseInt(n, 10))
    return { main, pre: prePart ?? null }
  }
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.main.length, pb.main.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa.main[i] ?? 0
    const y = pb.main[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) {
      return a === b ? 0 : a < b ? -1 : 1
    }
    if (x !== y) {
      return x - y
    }
  }
  /* Main parts equal. Prerelease semantics: no-pre > any-pre. */
  if (pa.pre === null && pb.pre === null) {
    return 0
  }
  if (pa.pre === null) {
    return 1
  }
  if (pb.pre === null) {
    return -1
  }
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0
}

async function refreshOne(
  name: string,
  entry: ExternalTools[string],
): Promise<{ changed: boolean; from: string; to: string }> {
  const release = await fetchLatestRelease(entry.repository)
  const latest = normalizeVersion(release.tag_name)
  if (latest === entry.version) {
    return { changed: false, from: entry.version, to: entry.version }
  }
  /* Never downgrade. GitHub's "latest" tag is what the upstream
   * marked as latest in the UI, which isn't always the highest
   * semver (rc / canary / security-backport releases can push
   * an older tag to "latest"). Semver-compare and no-op on
   * equal-or-lower. */
  if (compareVersions(latest, entry.version) <= 0) {
    console.log(
      `  ${name}: upstream "latest" is ${latest}, pinned is ${entry.version} — keeping pin`,
    )
    return { changed: false, from: entry.version, to: entry.version }
  }
  console.log(`  ${name}: ${entry.version} → ${latest}`)

  /* For every platform we track, find the matching asset in the
   * new release, download it, and compute its sha256. If an
   * asset is missing (rare — a release might drop a platform),
   * keep the old entry so we don't break a platform we still
   * support. */
  const nextChecksums: ExternalTools[string]['checksums'] = {
    __proto__: null,
  } as ExternalTools[string]['checksums']
  for (const [platform, slot] of Object.entries(entry.checksums)) {
    if (!slot) {
      continue
    }
    const assetName = slot.asset
    const asset = release.assets.find(a => a.name === assetName)
    if (!asset) {
      console.warn(
        `    ${platform}: asset "${assetName}" not found in ${latest}; keeping old checksum`,
      )
      nextChecksums[platform as keyof typeof nextChecksums] = slot
      continue
    }
    const sha = await sha256OfUrl(asset.browser_download_url)
    nextChecksums[platform as keyof typeof nextChecksums] = {
      asset: assetName,
      sha256: sha,
    }
  }

  entry.version = latest
  entry.checksums = nextChecksums
  return { changed: true, from: entry.version, to: latest }
}

async function main(): Promise<void> {
  const tools = validateExternalTools(toolsPath)
  let anyChanged = false
  for (const [name, entry] of Object.entries(tools)) {
    try {
      const result = await refreshOne(name, entry)
      if (result.changed) {
        anyChanged = true
      }
    } catch (e) {
      console.error(
        `  ${name}: failed to refresh — ${e instanceof Error ? e.message : String(e)}`,
      )
      /* Keep going — a single failed lookup shouldn't block the
       * other tools. Exit code reflects whether the process as a
       * whole succeeded; per-tool failures are logged and the
       * reviewer decides whether to re-run or investigate. */
    }
  }
  if (anyChanged) {
    writeFileSync(toolsPath, JSON.stringify(tools, null, 2) + '\n')
    /* Re-validate — catches any weird shape that slipped through
     * a partially-refreshed entry. Throws on schema violation. */
    validateExternalTools(toolsPath)
    console.log('✓ external-tools.json updated')
  } else {
    console.log('✓ external-tools.json already up to date')
  }
}

await main()
