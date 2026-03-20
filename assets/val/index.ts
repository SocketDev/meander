/**
 * Walkthrough Val — Hono-based HTTP handler for serving walkthrough HTML
 * from blob storage and managing comments via SQLite.
 *
 * Environment variables:
 *   WALKTHROUGH_USER — basic auth username
 *   WALKTHROUGH_PASS — basic auth password
 *
 * Blob key conventions:
 *   walkthrough/<slug>/index.html
 *   walkthrough/<slug>/walkthrough-part-<N>.html
 *   walkthrough/<slug>/manifest.json
 *   walkthrough/walkthrough.css
 */

import { Hono } from "npm:hono@4";
import { basicAuth } from "npm:hono@4/basic-auth";
import { blob } from "https://esm.town/v/std/blob";
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";
import type { BaseComment, ExportedComment, ExportedComments, ApiComment } from "./types.ts";

const app = new Hono();

/* ------------------------------------------------------------------ */
/*  Database init                                                      */
/* ------------------------------------------------------------------ */

let dbInitialized = false;

async function ensureDb() {
  if (dbInitialized) return;
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS comments (
      id         TEXT PRIMARY KEY,
      slug       TEXT NOT NULL,
      part       INTEGER NOT NULL,
      file       TEXT NOT NULL,
      line_from  INTEGER NOT NULL,
      line_to    INTEGER NOT NULL,
      author     TEXT NOT NULL,
      body       TEXT NOT NULL,
      parent_id  TEXT,
      resolved   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await sqlite.execute(`
    CREATE INDEX IF NOT EXISTS idx_comments_slug_part ON comments(slug, part)
  `);
  // Migrations: add columns if table already exists without them
  for (const col of ["parent_id TEXT", "resolved INTEGER NOT NULL DEFAULT 0"]) {
    try {
      await sqlite.execute(`ALTER TABLE comments ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }
  dbInitialized = true;
}

/* ------------------------------------------------------------------ */
/*  Basic auth middleware                                               */
/* ------------------------------------------------------------------ */

const user = Deno.env.get("WALKTHROUGH_USER") || "admin";
const pass = Deno.env.get("WALKTHROUGH_PASS") || "changeme";

app.use("*", basicAuth({ username: user, password: pass }));

/* ------------------------------------------------------------------ */
/*  Shared CSS (not per-walkthrough)                                   */
/* ------------------------------------------------------------------ */

app.get("/walkthrough.css", async (c) => {
  try {
    const data = await blob.get("walkthrough/walkthrough.css");
    const text = await data.text();
    return c.text(text, 200, { "Content-Type": "text/css; charset=utf-8" });
  } catch {
    return c.text("/* not found */", 404, { "Content-Type": "text/css" });
  }
});

/* ------------------------------------------------------------------ */
/*  Root — list available walkthroughs                                 */
/* ------------------------------------------------------------------ */

app.get("/", async (c) => {
  try {
    const blobs = await blob.list("walkthrough/");
    const slugs = new Set<string>();
    for (const b of blobs) {
      // Keys look like walkthrough/<slug>/index.html
      const parts = b.key.split("/");
      if (parts.length >= 3 && parts[0] === "walkthrough" && parts[1] !== "walkthrough.css") {
        slugs.add(parts[1]!);
      }
    }
    const links = [...slugs]
      .map((s) => `<li><a href="/${s}/">${s}</a></li>`)
      .join("\n");
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Walkthroughs</title>
<link rel="stylesheet" href="/walkthrough.css"></head>
<body><header class="topbar"><h1>Walkthroughs</h1></header>
<main style="padding:16px;max-width:900px;"><ul>${links || "<li>No walkthroughs published yet.</li>"}</ul></main></body></html>`;
    return c.html(html);
  } catch {
    return c.text("Error listing walkthroughs", 500);
  }
});

/* ------------------------------------------------------------------ */
/*  Walkthrough index                                                  */
/* ------------------------------------------------------------------ */

app.get("/:slug/", async (c) => {
  const slug = c.req.param("slug");
  return serveBlobHtml(c, `walkthrough/${slug}/index.html`);
});

app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  return c.redirect(`/${slug}/`, 301);
});

/* ------------------------------------------------------------------ */
/*  Walkthrough parts                                                  */
/* ------------------------------------------------------------------ */

app.get("/:slug/part/:id", async (c) => {
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  return serveBlobHtml(c, `walkthrough/${slug}/walkthrough-part-${id}.html`);
});

/* ------------------------------------------------------------------ */
/*  Comments API                                                       */
/* ------------------------------------------------------------------ */

app.get("/:slug/api/comments/unresolved", async (c) => {
  await ensureDb();
  const slug = c.req.param("slug");

  const result = await sqlite.execute({
    sql: "SELECT id, slug, part, file, line_from, line_to, author, body, parent_id, resolved, created_at FROM comments WHERE slug = :slug AND resolved = 0 AND parent_id IS NULL ORDER BY part ASC, created_at ASC",
    args: { slug },
  });

  const rows = result.rows.map((row: any) => ({
    id: row.id,
    slug: row.slug,
    part: row.part,
    file: row.file,
    lineFrom: row.line_from,
    lineTo: row.line_to,
    author: row.author,
    body: row.body,
    parentId: row.parent_id || null,
    resolved: !!row.resolved,
    createdAt: row.created_at,
  }));

  return c.json(rows);
});

app.get("/:slug/api/comments", async (c) => {
  await ensureDb();
  const slug = c.req.param("slug");
  const part = c.req.query("part");
  if (!part) {
    return c.json({ error: "part query parameter required" }, 400);
  }

  const result = await sqlite.execute({
    sql: "SELECT id, slug, part, file, line_from, line_to, author, body, parent_id, resolved, created_at FROM comments WHERE slug = :slug AND part = :part ORDER BY created_at ASC",
    args: { slug, part: parseInt(part, 10) },
  });

  const rows = result.rows.map((row: any) => ({
    id: row.id,
    slug: row.slug,
    part: row.part,
    file: row.file,
    lineFrom: row.line_from,
    lineTo: row.line_to,
    author: row.author,
    body: row.body,
    parentId: row.parent_id || null,
    resolved: !!row.resolved,
    createdAt: row.created_at,
  }));

  return c.json(rows);
});

app.post("/:slug/api/comments", async (c) => {
  await ensureDb();
  const slug = c.req.param("slug");
  const body = await c.req.json();
  const { part, file, lineFrom, lineTo, author, body: commentBody, parentId } = body;

  if (!part || !file || !lineFrom || !author || !commentBody) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  const id = crypto.randomUUID();
  await sqlite.execute({
    sql: "INSERT INTO comments (id, slug, part, file, line_from, line_to, author, body, parent_id) VALUES (:id, :slug, :part, :file, :lineFrom, :lineTo, :author, :body, :parentId)",
    args: {
      id,
      slug,
      part,
      file,
      lineFrom,
      lineTo: lineTo || lineFrom,
      author,
      body: commentBody,
      parentId: parentId || null,
    },
  });

  return c.json({
    id,
    slug,
    part,
    file,
    lineFrom,
    lineTo: lineTo || lineFrom,
    author,
    body: commentBody,
    parentId: parentId || null,
    createdAt: new Date().toISOString(),
  }, 201);
});

app.patch("/:slug/api/comments/:id", async (c) => {
  await ensureDb();
  const id = c.req.param("id");
  const body = await c.req.json();
  const { resolved } = body;
  if (typeof resolved !== "boolean") {
    return c.json({ error: "resolved field (boolean) required" }, 400);
  }
  await sqlite.execute({
    sql: "UPDATE comments SET resolved = :resolved WHERE id = :id",
    args: { id, resolved: resolved ? 1 : 0 },
  });
  return c.json({ ok: true, id, resolved });
});

app.delete("/:slug/api/comments/:id", async (c) => {
  await ensureDb();
  const id = c.req.param("id");
  await sqlite.execute({
    sql: "DELETE FROM comments WHERE id = :id",
    args: { id },
  });
  return c.json({ ok: true });
});

app.get("/:slug/api/comments/export", async (c) => {
  await ensureDb();
  const slug = c.req.param("slug");
  const unresolvedOnly = c.req.query("unresolved") === "true";

  // Build query based on whether we want all or just unresolved
  let sql = "SELECT id, slug, part, file, line_from, line_to, author, body, parent_id, resolved, created_at FROM comments WHERE slug = :slug";
  if (unresolvedOnly) {
    sql += " AND resolved = 0";
  }
  sql += " ORDER BY part ASC, file ASC, line_from ASC, created_at ASC";

  const result = await sqlite.execute({
    sql,
    args: { slug },
  });

  // Transform to API format
  const comments: ApiComment[] = result.rows.map((row: any) => ({
    id: row.id,
    slug: row.slug,
    part: row.part,
    file: row.file,
    lineFrom: row.line_from,
    lineTo: row.line_to,
    author: row.author,
    body: row.body,
    parentId: row.parent_id || null,
    resolved: !!row.resolved,
    createdAt: row.created_at,
  }));

  // Build parent lookup for thread reconstruction
  const commentById = new Map<string, ApiComment>();
  for (const comment of comments) {
    commentById.set(comment.id, comment);
  }

  // Group root comments by file + line range
  const rootComments = comments.filter(c => !c.parentId);
  const repliesByParentId = new Map<string, ApiComment[]>();
  
  for (const comment of comments) {
    if (comment.parentId) {
      const siblings = repliesByParentId.get(comment.parentId) || [];
      siblings.push(comment);
      repliesByParentId.set(comment.parentId, siblings);
    }
  }

  // Build exported comments with threaded structure
  const exportedComments: ExportedComments = rootComments.map((root): ExportedComment => {
    // Get all replies for this root comment
    const replies = repliesByParentId.get(root.id) || [];
    
    // Convert replies to BaseComment format
    const children: BaseComment[] = replies.map(reply => ({
      author: reply.author,
      datetime: new Date(reply.createdAt).getTime(),
      content: reply.body,
    }));

    return {
      author: root.author,
      datetime: new Date(root.createdAt).getTime(),
      content: root.body,
      children,
      sourceFile: root.file,
      startLine: root.lineFrom,
      endLine: root.lineTo,
    };
  });

  // Set headers for JSON file download
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${slug}-comments.json"`);
  
  return c.json(exportedComments);
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function serveBlobHtml(c: any, key: string) {
  try {
    const data = await blob.get(key);
    const text = await data.text();
    return c.html(text);
  } catch {
    return c.text("Not found", 404);
  }
}

/* ------------------------------------------------------------------ */
/*  Export                                                             */
/* ------------------------------------------------------------------ */

export default app.fetch;
