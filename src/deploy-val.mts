import ValTown from "@valtown/sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = "https://api.val.town";

function getValSourcePath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(thisFile), "..", "assets", "val", "index.ts");
}

export async function deployVal(valName: string): Promise<void> {
  const token = process.env["VALTOWN_TOKEN"];
  if (!token) {
    throw new Error("VALTOWN_TOKEN environment variable is required");
  }

  const walkthroughUser: string = process.env["WALKTHROUGH_USER"] ?? "";
  const walkthroughPass: string = process.env["WALKTHROUGH_PASS"] ?? "";
  if (!walkthroughUser || !walkthroughPass) {
    throw new Error("WALKTHROUGH_USER and WALKTHROUGH_PASS environment variables are required");
  }

  const client = new ValTown({ bearerToken: token });

  const valSource = readFileSync(getValSourcePath(), "utf-8");

  const profile = await client.me.profile.retrieve();
  const username = profile.username ?? "";
  console.log(`Logged in as: ${username}`);
  console.log(`Looking for existing val "${valName}"...`);

  let valId: string | null = null;
  try {
    const val = await client.alias.username.valName.retrieve(username, valName);
    valId = val.id;
  } catch {
    valId = null;
  }

  if (valId) {
    console.log(`Found existing val: ${valId}`);
  } else {
    console.log(`Creating new val "${valName}"...`);
    const created = await client.vals.create({
      name: valName,
      privacy: "unlisted",
      description: "Walkthrough viewer with comments",
    });
    valId = created.id;
    console.log(`Created val: ${valId}`);
  }

  // Update the HTTP trigger file
  console.log("Updating val source code...");
  try {
    await client.vals.files.update(valId, {
      path: "index.ts",
      content: valSource,
      type: "http",
    });
    console.log("Updated index.ts");
  } catch {
    await client.vals.files.create(valId, {
      path: "index.ts",
      content: valSource,
      type: "http",
    });
    console.log("Created index.ts");
  }

  // Set environment variables
  console.log("Setting environment variables...");
  for (const [key, value] of [
    ["WALKTHROUGH_USER", walkthroughUser],
    ["WALKTHROUGH_PASS", walkthroughPass],
  ] satisfies Array<[string, string]>) {
    const updateRes = await fetch(`${API_BASE}/v2/vals/${valId}/environment_variables/${key}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value }),
    });
    if (updateRes.ok) {
      console.log(`  Updated ${key}`);
      continue;
    }

    const createRes = await fetch(`${API_BASE}/v2/vals/${valId}/environment_variables`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key, value }),
    });
    if (createRes.ok) {
      console.log(`  Created ${key}`);
      continue;
    }

    throw new Error(`Failed to set env var ${key}: ${createRes.status} ${await createRes.text()}`);
  }

  const val = await client.vals.retrieve(valId);
  console.log(`\nDone! Val URL: ${val.links.html}`);
}
