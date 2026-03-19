import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const API_BASE = "https://api.val.town";

async function uploadBlob(token: string, key: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/blob/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
    },
    body: content,
  });
  if (!res.ok) {
    throw new Error(`Failed to upload blob ${key}: ${res.status} ${await res.text()}`);
  }
  console.log(`  Uploaded: ${key}`);
}

export async function publish(configPath: string): Promise<void> {
  const token = process.env["VALTOWN_TOKEN"];
  if (!token) {
    throw new Error("VALTOWN_TOKEN environment variable is required");
  }

  const resolved = resolve(configPath);
  const config = JSON.parse(readFileSync(resolved, "utf-8"));
  const slug: string = config.slug;
  if (!slug) {
    throw new Error("walkthrough.json must have a 'slug' field");
  }

  const walkthroughDir = join(resolved, "..");
  const parts: Array<{ id: number }> = config.parts;

  console.log(`Publishing walkthrough "${slug}" (${parts.length} parts)...`);

  // Upload shared CSS
  const css = readFileSync(join(walkthroughDir, "walkthrough.css"), "utf-8");
  await uploadBlob(token, "walkthrough/walkthrough.css", css);

  // Upload index.html
  const indexHtml = readFileSync(join(walkthroughDir, "index.html"), "utf-8");
  await uploadBlob(token, `walkthrough/${slug}/index.html`, indexHtml);

  // Upload part HTML files
  for (const part of parts) {
    const filename = `walkthrough-part-${part.id}.html`;
    const html = readFileSync(join(walkthroughDir, filename), "utf-8");
    await uploadBlob(token, `walkthrough/${slug}/${filename}`, html);
  }

  // Upload manifest
  const manifest = readFileSync(join(walkthroughDir, "manifest.json"), "utf-8");
  await uploadBlob(token, `walkthrough/${slug}/manifest.json`, manifest);

  console.log(`\nDone! Published ${parts.length + 2} files for "${slug}".`);
}
