import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import {
  DOCUMENTS_ROOT,
  ensureRoot,
  exists,
  listDir,
  mkdirRecursive,
  remove,
  rename as fsRename,
  sanitizeRelPath,
  stat,
  walkAll,
  writeFile,
  getExtension,
  baseName,
  type SafeRel,
} from "@/lib/documents/fs";

// Disable Next.js caching — every read should be live.
export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any -- action-based route */
type Json = Record<string, any>;
const ok = (data: Json = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = await sql`select id from workspaces order by created_at asc limit 1`;
  return rows[0]?.id ?? null;
}

/**
 * Boot-time safety net for documents tables. Mirrors db/schema.sql so a running
 * dev app self-heals before the operator runs npm run db:migrate.
 */
async function ensureSchema(sql: ReturnType<typeof getSql>) {
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      relative_path text NOT NULL,
      kind text NOT NULL DEFAULT 'file',
      size_bytes integer NOT NULL DEFAULT 0,
      extension text,
      created_by_email text,
      created_by_name text,
      last_edited_by_email text,
      last_edited_by_name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, relative_path)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS documents_workspace_idx ON documents(workspace_id)`;
  await sql`CREATE INDEX IF NOT EXISTS documents_path_idx ON documents(workspace_id, relative_path)`;
  await sql`
    CREATE TABLE IF NOT EXISTS document_audit (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
      workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_email text,
      actor_name text,
      event text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS document_audit_doc_idx ON document_audit(document_id, occurred_at desc)`;
  await sql`CREATE INDEX IF NOT EXISTS document_audit_workspace_recent_idx ON document_audit(workspace_id, occurred_at desc)`;
  await sql`
    CREATE TABLE IF NOT EXISTS ticket_documents (
      ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      linked_by_email text,
      linked_by_name text,
      linked_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ticket_id, document_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS ticket_documents_doc_idx ON ticket_documents(document_id)`;
}

async function audit(
  sql: ReturnType<typeof getSql>,
  wid: string,
  params: {
    documentId?: string | null;
    actor: { name: string | null; email: string | null };
    event: string;
    details?: Record<string, unknown>;
  },
) {
  await sql`
    insert into document_audit (document_id, workspace_id, actor_email, actor_name, event, details)
    values (${params.documentId || null}, ${wid}, ${params.actor.email}, ${params.actor.name}, ${params.event}, ${JSON.stringify(params.details || {})}::jsonb)
  `;
}

async function upsertDocumentRow(
  sql: ReturnType<typeof getSql>,
  wid: string,
  rel: SafeRel,
  kind: "file" | "folder",
  actor: { name: string | null; email: string | null },
): Promise<string> {
  const size = kind === "file" ? (exists(rel) ? (await stat(rel)).size : 0) : 0;
  const ext = kind === "file" ? getExtension(rel) : null;
  const rows = await sql`
    insert into documents (workspace_id, relative_path, kind, size_bytes, extension, created_by_email, created_by_name, last_edited_by_email, last_edited_by_name)
    values (${wid}, ${rel}, ${kind}, ${size}, ${ext}, ${actor.email}, ${actor.name}, ${actor.email}, ${actor.name})
    on conflict (workspace_id, relative_path) do update
      set size_bytes = excluded.size_bytes,
          extension = excluded.extension,
          last_edited_by_email = ${actor.email},
          last_edited_by_name = ${actor.name},
          updated_at = now()
    returning id::text
  `;
  return rows[0].id as string;
}

async function findDocByPath(
  sql: ReturnType<typeof getSql>,
  wid: string,
  rel: SafeRel,
): Promise<{ id: string } | null> {
  const rows = await sql`
    select id::text from documents where workspace_id = ${wid} and relative_path = ${rel} limit 1
  `;
  return rows[0] ? { id: rows[0].id as string } : null;
}

// ─── GET ──────────────────────────────────────────────────────────────────────
// /api/documents                    → list root + walk for tree
// /api/documents?path=folder        → list one folder
// /api/documents?recent=1           → recent-edited list (capped)

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    const sql = getSql();
    await ensureSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return ok({ entries: [], tree: [] });

    await ensureRoot();
    const url = new URL(request.url);
    const path = url.searchParams.get("path");

    if (url.searchParams.has("recent")) {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 12), 1), 50);
      const rows = await sql`
        select id::text, relative_path, kind, size_bytes, extension, updated_at,
               last_edited_by_name, last_edited_by_email,
               created_by_name, created_by_email, created_at
        from documents
        where workspace_id = ${wid} and kind = 'file'
        order by updated_at desc
        limit ${limit}
      `;
      return ok({ recent: rows });
    }

    if (path !== null) {
      const safe = sanitizeRelPath(path, { allowEmpty: true });
      const entries = await listDir(safe);
      return ok({ entries, path: safe });
    }

    // Default: walk everything (tree + entries) for the page initial load.
    const all = await walkAll();
    return ok({ entries: all, root: DOCUMENTS_ROOT });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to list documents", 500);
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);

    const sql = getSql();
    await ensureSchema(sql);
    const wid = await workspaceId(sql);
    if (!wid) return fail("Workspace not found", 500);

    await ensureRoot();

    const body = (await request.json()) as Json;
    const action = String(body.action || "");
    const actor = { name: session.name?.trim() || null, email: session.email.toLowerCase() };

    if (action === "createFolder") {
      const rel = sanitizeRelPath(body.path);
      if (exists(rel)) return fail("A file or folder already exists at that path.");
      await mkdirRecursive(rel);
      const docId = await upsertDocumentRow(sql, wid, rel, "folder", actor);
      await audit(sql, wid, { documentId: docId, actor, event: "folder_created", details: { path: rel } });
      return ok({ document: { id: docId, relativePath: rel, kind: "folder" } });
    }

    if (action === "createFile") {
      const rel = sanitizeRelPath(body.path);
      if (exists(rel)) return fail("A file or folder already exists at that path.");
      const content = typeof body.content === "string" ? body.content : "";
      await writeFile(rel, content);
      const docId = await upsertDocumentRow(sql, wid, rel, "file", actor);
      await audit(sql, wid, {
        documentId: docId,
        actor,
        event: "created",
        details: { path: rel, bytes: Buffer.byteLength(content, "utf8") },
      });
      return ok({ document: { id: docId, relativePath: rel, kind: "file" } });
    }

    if (action === "updateContent") {
      const rel = sanitizeRelPath(body.path);
      if (!exists(rel)) return fail("File not found.", 404);
      const st = await stat(rel);
      if (!st.isFile()) return fail("Target is not a file.");
      const content = typeof body.content === "string" ? body.content : "";
      await writeFile(rel, content);
      const docId = await upsertDocumentRow(sql, wid, rel, "file", actor);
      await audit(sql, wid, {
        documentId: docId,
        actor,
        event: "updated",
        details: { path: rel, bytes: Buffer.byteLength(content, "utf8") },
      });
      return ok({ document: { id: docId, relativePath: rel, kind: "file" } });
    }

    if (action === "rename" || action === "move") {
      const fromRel = sanitizeRelPath(body.fromPath);
      const toRel = sanitizeRelPath(body.toPath);
      if (!exists(fromRel)) return fail("Source not found.", 404);
      if (exists(toRel)) return fail("A file or folder already exists at the destination.");
      await fsRename(fromRel, toRel);
      // Update existing rows whose paths begin with the old prefix to use the new one.
      await sql`
        update documents
        set relative_path = ${toRel} || substring(relative_path from ${fromRel.length + 1}),
            updated_at = now()
        where workspace_id = ${wid}
          and (relative_path = ${fromRel} or relative_path like ${fromRel + "/%"})
      `;
      const doc = await findDocByPath(sql, wid, toRel);
      await audit(sql, wid, {
        documentId: doc?.id || null,
        actor,
        event: action === "rename" ? "renamed" : "moved",
        details: { from: fromRel, to: toRel },
      });
      return ok({ from: fromRel, to: toRel });
    }

    if (action === "deleteDoc") {
      const rel = sanitizeRelPath(body.path);
      if (!exists(rel)) return fail("Not found.", 404);
      const doc = await findDocByPath(sql, wid, rel);
      const name = baseName(rel);
      await remove(rel);
      // Cascade-clean DB rows for this path or any descendant of it.
      await sql`
        delete from documents
        where workspace_id = ${wid}
          and (relative_path = ${rel} or relative_path like ${rel + "/%"})
      `;
      await audit(sql, wid, {
        documentId: doc?.id || null,
        actor,
        event: "deleted",
        details: { path: rel, name },
      });
      return ok({ path: rel });
    }

    if (action === "listAudit") {
      const documentId = body.documentId ? String(body.documentId) : null;
      const limit = Math.min(Math.max(Number(body.limit || 50), 1), 200);
      if (documentId) {
        const rows = await sql`
          select id::text, document_id::text, actor_email, actor_name, event, details, occurred_at
          from document_audit
          where document_id = ${documentId}
          order by occurred_at desc
          limit ${limit}
        `;
        return ok({ audit: rows });
      }
      const rows = await sql`
        select id::text, document_id::text, actor_email, actor_name, event, details, occurred_at
        from document_audit
        where workspace_id = ${wid}
        order by occurred_at desc
        limit ${limit}
      `;
      return ok({ audit: rows });
    }

    if (action === "listDocumentTickets") {
      const documentId = String(body.documentId || "");
      if (!documentId) return fail("documentId is required.");
      const rows = await sql`
        select t.id::text, t.title, t.board_id::text as board_id, b.name as board_name,
               td.linked_at, td.linked_by_name
        from ticket_documents td
        join tickets t on t.id = td.ticket_id
        join boards b on b.id = t.board_id
        where td.document_id = ${documentId}
        order by td.linked_at desc
      `;
      return ok({ tickets: rows });
    }

    return fail(`Unsupported action: ${action}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Document operation failed", 500);
  }
}
