import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { deriveKey, encrypt } from "./crypto.mts";
import { missingTokenMessage, resolveValTownToken } from "./valtown-token.mts";

const API_BASE = "https://api.val.town";

export type PublishOptions = {
  /** Override the env var read for the bearer token. Default:
   *  MEANDER_VALTOWN_TOKEN_ENV or VALTOWN_TOKEN. */
  tokenEnv?: string | undefined;
  /** When true, missing token / password log a warning and
   *  return 0 instead of throwing. Used by CI workflows that
   *  shouldn't fail just because the publish secret isn't
   *  provisioned (e.g. fork PRs). */
  graceful?: boolean | undefined;
};

async function uploadBlob(token: string, key: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/blob/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: content,
  });
  if (!res.ok) {
    throw new Error(`Failed to upload blob ${key}: ${res.status} ${await res.text()}`);
  }
  console.log(`  Uploaded: ${key}`);
}

function encryptHtml(html: string, key: Buffer): string {
  return encrypt(html, key);
}

export async function publish(
  configPath: string,
  options: PublishOptions = { __proto__: null } as PublishOptions,
): Promise<void> {
  const { tokenEnv, graceful = false } = {
    __proto__: null,
    ...options,
  } as PublishOptions;

  const { envName, token } = resolveValTownToken(tokenEnv);
  if (!token) {
    const msg = missingTokenMessage(envName);
    if (graceful) {
      console.log(`[publish] skipped — ${msg}`);
      return;
    }
    throw new Error(msg);
  }

  const password = process.env["WALKTHROUGH_PASS"];
  if (!password) {
    const msg = "WALKTHROUGH_PASS environment variable is required for publish (used to derive the at-rest encryption key).";
    if (graceful) {
      console.log(`[publish] skipped — ${msg}`);
      return;
    }
    throw new Error(msg);
  }

  const key = deriveKey(password);
  const resolved = path.resolve(configPath);
  const config = JSON.parse(readFileSync(resolved, "utf-8"));
  const slug: string = config.slug;
  if (!slug) {
    throw new Error("walkthrough.json must have a 'slug' field");
  }

  const configDir = path.join(resolved, "..");
  const walkthroughDir = path.join(configDir, "walkthrough");
  const parts: Array<{ id: number }> = config.parts;

  console.log(`Publishing walkthrough "${slug}" (${parts.length} parts)...`);

  // Upload shared CSS
  const css = readFileSync(path.join(walkthroughDir, "meander.css"), "utf-8");
  await uploadBlob(token, "walkthrough/meander.css", css);

  // Upload index.html (encrypted)
  const indexHtml = readFileSync(path.join(walkthroughDir, "index.html"), "utf-8");
  await uploadBlob(token, `walkthrough/${slug}/index.html`, encryptHtml(indexHtml, key));

  // Upload part HTML files (encrypted)
  for (const part of parts) {
    const filename = `walkthrough-part-${part.id}.html`;
    const html = readFileSync(path.join(walkthroughDir, filename), "utf-8");
    await uploadBlob(token, `walkthrough/${slug}/${filename}`, encryptHtml(html, key));
  }

  // Upload documents.html if present (encrypted)
  const documentsPath = path.join(walkthroughDir, "documents.html");
  let hasDocuments = false;
  if (existsSync(documentsPath)) {
    const documentsHtml = readFileSync(documentsPath, "utf-8");
    await uploadBlob(token, `walkthrough/${slug}/documents.html`, encryptHtml(documentsHtml, key));
    hasDocuments = true;
  }

  // Upload manifest
  const manifest = readFileSync(path.join(walkthroughDir, "manifest.json"), "utf-8");
  await uploadBlob(token, `walkthrough/${slug}/manifest.json`, manifest);

  const fileCount = parts.length + 2 + (hasDocuments ? 1 : 0);
  console.log(`\nDone! Published ${fileCount} files for "${slug}".`);
}
