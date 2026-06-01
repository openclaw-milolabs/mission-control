import { promises as fsp } from "node:fs";
import { resolve } from "node:path";
import type { getSql } from "@/lib/local-db";

const DOCUMENTS_ROOT = resolve(process.cwd(), "documents");

type Sql = ReturnType<typeof getSql>;

export type ModulePreview = {
  /** Headline counts shown as the impact summary. */
  counts: Array<{ icon: string; label: string; n: number }>;
  /** Optional human-readable bytes-on-disk string. */
  bytesOnDisk: number | null;
  /** Affected items the user should see explicitly (e.g. tickets that will lose links). */
  sampleAffected: Array<{ kind: string; label: string; context?: string }>;
  /** Sentence-shaped final warning. */
  finalWarning: string;
};

async function dirSize(dir: string): Promise<number> {
  try {
    let total = 0;
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const cur = stack.shift()!;
      let entries: Awaited<ReturnType<typeof fsp.readdir>>;
      try { entries = await fsp.readdir(cur, { withFileTypes: true }); }
      catch { continue; }
      for (const ent of entries) {
        const p = `${cur}/${ent.name}`;
        if (ent.isDirectory()) stack.push(p);
        else {
          try { const st = await fsp.stat(p); total += st.size; } catch { /* ignore */ }
        }
      }
    }
    return total;
  } catch { return 0; }
}

export const documentsHandler = {
  async preview(sql: Sql): Promise<ModulePreview> {
    const [docs, folders, audit, links] = await Promise.all([
      sql`select count(*)::int as n from documents where kind = 'file'`.catch(() => [{ n: 0 }]),
      sql`select count(*)::int as n from documents where kind = 'folder'`.catch(() => [{ n: 0 }]),
      sql`select count(*)::int as n from document_audit`.catch(() => [{ n: 0 }]),
      sql`select count(*)::int as n from ticket_documents`.catch(() => [{ n: 0 }]),
    ]);

    const sampleTickets = await sql`
      select t.id::text, t.title, b.name as board_name
      from ticket_documents td
      join tickets t on t.id = td.ticket_id
      join boards b on b.id = t.board_id
      order by td.linked_at desc
      limit 5
    `.catch(() => []) as Array<{ id: string; title: string; board_name: string }>;

    const bytesOnDisk = await dirSize(DOCUMENTS_ROOT);

    return {
      counts: [
        { icon: "📄", label: "documents", n: Number((docs as Array<{ n: number }>)[0]?.n ?? 0) },
        { icon: "📁", label: "folders", n: Number((folders as Array<{ n: number }>)[0]?.n ?? 0) },
        { icon: "📝", label: "audit log entries", n: Number((audit as Array<{ n: number }>)[0]?.n ?? 0) },
        { icon: "🔗", label: "links from kanban tickets", n: Number((links as Array<{ n: number }>)[0]?.n ?? 0) },
      ],
      bytesOnDisk,
      sampleAffected: sampleTickets.map((t) => ({
        kind: "ticket",
        label: t.title,
        context: t.board_name,
      })),
      finalWarning:
        "Disabling Documents permanently deletes every document, its on-disk file, all audit history, and unlinks them from kanban tickets. This cannot be undone.",
    };
  },

  async cleanup(sql: Sql): Promise<void> {
    // FS first: drop the entire documents directory. The DB tables go next.
    // ticket_documents.document_id has ON DELETE CASCADE so dropping documents
    // also drops every link row.
    await fsp.rm(DOCUMENTS_ROOT, { recursive: true, force: true });
    await sql`DROP TABLE IF EXISTS document_audit CASCADE`;
    await sql`DROP TABLE IF EXISTS documents CASCADE`;
  },

  async setup(sql: Sql): Promise<void> {
    // Re-enable: recreate the same schema the boot migration in /api/documents
    // already declares. Both definitions must stay in sync; the canonical form
    // is db/schema.sql.
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
    await fsp.mkdir(DOCUMENTS_ROOT, { recursive: true });
  },
};
