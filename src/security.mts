/**
 * Build-time security hardening utilities:
 *
 *   - computeIntegrity(bytes) → sha512 SRI hash string
 *   - sriForUrl(url, options) → hash for a CDN URL, disk-cached
 *   - injectSriIntegrity(html, options) → rewrite <script src> /
 *     <link rel=stylesheet|preload|modulepreload> with
 *     integrity="..." attributes
 *   - buildCspMeta(html, options) → <meta http-equiv="Content-
 *     Security-Policy"> tag with per-inline-script/style hashes
 *     plus allow-listed origins
 *
 * All functions are idempotent — tags that already carry
 * `integrity=` or pages that already have a CSP meta are left
 * alone.
 */
import { hash as cryptoHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { HTMLElement, parse as parseHtml } from "node-html-parser";

/**
 * SRI-format sha512 hash string for raw bytes:
 * `sha512-<base64>`. Use for `<script integrity>` or
 * `<link integrity>` attributes.
 */
export function computeIntegrity(bytes: Uint8Array): string {
  return `sha512-${cryptoHash("sha512", bytes, "base64")}`;
}

export type SriForUrlOptions = {
  cacheDir?: string | undefined;
};

/**
 * Fetch a remote resource and compute its SRI hash. Result is
 * cached to disk when `cacheDir` is provided so subsequent
 * builds don't re-fetch. Cache key is the URL (base64url
 * encoded).
 */
export async function sriForUrl(
  url: string,
  options: SriForUrlOptions = { __proto__: null } as SriForUrlOptions,
): Promise<string> {
  const { cacheDir } = { __proto__: null, ...options } as SriForUrlOptions;
  if (cacheDir) {
    const key = Buffer.from(url).toString("base64url");
    const cachePath = path.join(cacheDir, `${key}.txt`);
    if (existsSync(cachePath)) {
      return (await fs.readFile(cachePath, "utf8")).trim();
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`SRI fetch ${url} → HTTP ${res.status}`);
    }
    const integrity = computeIntegrity(new Uint8Array(await res.arrayBuffer()));
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cachePath, integrity + "\n");
    return integrity;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SRI fetch ${url} → HTTP ${res.status}`);
  }
  return computeIntegrity(new Uint8Array(await res.arrayBuffer()));
}

export type InjectSriOptions = {
  /**
   * Directory where locally-emitted assets live. Same-origin
   * refs (starting with `/`) are read from this directory to
   * compute their hash. Omit to skip same-origin refs.
   */
  localDir?: string | undefined;
  /**
   * Prefix stripped from same-origin refs before looking them up
   * in `localDir`. Matches `basePath` from the generator.
   */
  basePath?: string | undefined;
  /**
   * Directory to disk-cache remote-URL hashes. Omit to re-fetch
   * every build.
   */
  cacheDir?: string | undefined;
  /**
   * Hosts to consider "remote" for SRI purposes. Any absolute
   * URL whose host is in this list will be fetched + hashed;
   * everything else (other absolute URLs, bare paths without
   * `localDir`, etc.) is skipped. Default:
   * `["unpkg.com", "cdn.jsdelivr.net"]`.
   */
  remoteHosts?: readonly string[] | undefined;
};

/**
 * Walk every `<script src>` / `<link rel=stylesheet|preload|
 * modulepreload href>` in the HTML and inject
 * `integrity="sha512-..."`. Returns the transformed HTML string.
 *
 * Sources it handles:
 *   - `https://<allowlisted-host>/...` → fetched + (optionally)
 *     disk-cached, tagged with `crossorigin="anonymous"`.
 *   - `/foo.js` (root-relative) → read from `localDir`.
 *   - `{basePath}/foo.js` → basePath stripped, then read from
 *     `localDir`.
 *
 * Tags that already carry `integrity=` are left alone.
 * `<link rel=icon>` / `<link rel=apple-touch-icon>` are skipped
 * since browsers ignore SRI on them.
 */
export async function injectSriIntegrity(
  html: string,
  options: InjectSriOptions = { __proto__: null } as InjectSriOptions,
): Promise<string> {
  const {
    localDir,
    basePath,
    cacheDir,
    remoteHosts = ["unpkg.com", "cdn.jsdelivr.net"],
  } = { __proto__: null, ...options } as InjectSriOptions;
  const root = parseHtml(html);
  const integrityByRef = new Map<string, string>();
  const isRemote = (u: string): boolean => {
    if (!u.startsWith("https://")) {
      return false;
    }
    try {
      const parsed = new URL(u);
      return (remoteHosts ?? []).some((h) => parsed.host === h);
    } catch {
      return false;
    }
  };

  const resolveIntegrity = async (ref: string): Promise<string | null> => {
    if (integrityByRef.has(ref)) {
      return integrityByRef.get(ref) || null;
    }
    let integrity: string | null = null;
    if (isRemote(ref)) {
      integrity = await sriForUrl(ref, { cacheDir });
    } else if (ref.startsWith("/") && localDir) {
      const bareRef =
        basePath && ref.startsWith(basePath + "/")
          ? ref.slice(basePath.length)
          : ref;
      const localPath = path.join(localDir, bareRef);
      if (existsSync(localPath)) {
        integrity = computeIntegrity(await fs.readFile(localPath));
      }
    }
    integrityByRef.set(ref, integrity ?? "");
    return integrity;
  };

  const getRef = (el: HTMLElement): string | null => {
    const tag = el.rawTagName.toLowerCase();
    if (tag === "script") {
      const src = el.getAttribute("src");
      if (!src) {
        return null;
      }
      return isRemote(src) || src.startsWith("/") ? src : null;
    }
    const rel = (el.getAttribute("rel") ?? "").toLowerCase();
    if (!/\b(?:stylesheet|preload|modulepreload)\b/.test(rel)) {
      return null;
    }
    const href = el.getAttribute("href");
    if (!href) {
      return null;
    }
    return isRemote(href) || href.startsWith("/") ? href : null;
  };

  const candidates: HTMLElement[] = [];
  for (const el of root.querySelectorAll("script,link")) {
    if (el.getAttribute("integrity")) {
      continue;
    }
    const ref = getRef(el);
    if (ref) {
      candidates.push(el);
    }
  }

  /* allSettled: a single fetch failure (CDN hiccup on a remote
   * ref, missing local file, etc.) shouldn't abort SRI for the
   * other tags. Failures are logged inside resolveIntegrity;
   * the integrityByRef map just won't have a hash for the
   * failing ref, and the later write loop skips tags with
   * no hash. */
  await Promise.allSettled(
    candidates.map((el) => {
      const ref = getRef(el);
      if (!ref) {
        return Promise.resolve(null);
      }
      return resolveIntegrity(ref);
    }),
  );

  for (const el of candidates) {
    const ref = getRef(el);
    if (!ref) {
      continue;
    }
    const integrity = integrityByRef.get(ref);
    if (!integrity) {
      continue;
    }
    el.setAttribute("integrity", integrity);
    if (ref.startsWith("https://")) {
      el.setAttribute("crossorigin", "anonymous");
    }
  }

  return root.toString();
}

export type BuildCspOptions = {
  /**
   * Origins the page connects to via fetch/XHR beyond its own.
   * Added to `connect-src`. Example: a comment-backend URL.
   */
  connectSrc?: readonly string[] | undefined;
  /**
   * Origins that serve scripts/styles via CDN URLs. Added to
   * both `script-src` and `style-src`. Default:
   * `["https://unpkg.com"]`.
   */
  cdnHosts?: readonly string[] | undefined;
};

/**
 * Build a tight Content-Security-Policy meta tag for the HTML,
 * by hashing every inline `<script>` and `<style>` body so no
 * `'unsafe-inline'` is needed. Returns the CSP content string
 * (not the full tag).
 *
 * Directives:
 *   default-src          'self'
 *   script-src           'self' + cdn + inline hashes
 *   style-src            'self' + cdn + inline style hashes
 *   connect-src          'self' + consumer's connectSrc
 *   img-src              'self' data:
 *   font-src             'self'
 *   worker-src           'self'
 *   base-uri, form-action 'self'
 *   frame-ancestors      'none' (clickjacking)
 */
export function buildCspContent(
  html: string,
  options: BuildCspOptions = { __proto__: null } as BuildCspOptions,
): string {
  const {
    connectSrc = [],
    cdnHosts = ["https://unpkg.com"],
  } = { __proto__: null, ...options } as BuildCspOptions;

  const root = parseHtml(html);

  const inlineScriptHashes = new Set<string>();
  for (const s of root.querySelectorAll("script")) {
    if (s.getAttribute("src")) {
      continue;
    }
    const body = s.text ?? "";
    if (!body) {
      continue;
    }
    inlineScriptHashes.add(
      `'sha256-${cryptoHash("sha256", body, "base64")}'`,
    );
  }

  const inlineStyleHashes = new Set<string>();
  for (const s of root.querySelectorAll("style")) {
    const body = s.text ?? "";
    if (!body) {
      continue;
    }
    inlineStyleHashes.add(
      `'sha256-${cryptoHash("sha256", body, "base64")}'`,
    );
  }
  /* style="..." attributes each need their own sha256 hash. */
  for (const el of root.querySelectorAll("[style]")) {
    const style = el.getAttribute("style");
    if (!style) {
      continue;
    }
    inlineStyleHashes.add(
      `'sha256-${cryptoHash("sha256", style, "base64")}'`,
    );
  }

  const scriptSrc = [
    "'self'",
    ...cdnHosts,
    ...[...inlineScriptHashes].sort(),
  ].join(" ");
  const styleSrc = [
    "'self'",
    ...cdnHosts,
    ...[...inlineStyleHashes].sort(),
    "'unsafe-hashes'",
  ].join(" ");
  const connect = ["'self'", ...connectSrc].join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `connect-src ${connect}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "worker-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Inject a `<meta http-equiv="Content-Security-Policy">` tag
 * into `<head>`. Idempotent — a page that already has a CSP
 * meta is returned unchanged.
 */
export function injectCspMeta(
  html: string,
  options: BuildCspOptions = { __proto__: null } as BuildCspOptions,
): string {
  const root = parseHtml(html);
  const head = root.querySelector("head");
  if (!head) {
    return html;
  }
  const existing = head.querySelector(
    'meta[http-equiv="Content-Security-Policy"]',
  );
  if (existing) {
    return html;
  }
  const content = buildCspContent(html, options);
  const tag = `<meta http-equiv="Content-Security-Policy" content="${content.replace(/"/g, "&quot;")}">`;
  head.insertAdjacentHTML("afterbegin", tag);
  return root.toString();
}
