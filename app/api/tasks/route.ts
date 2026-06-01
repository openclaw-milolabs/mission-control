import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";

type Actor = { name: string | null; email: string | null };

/* eslint-disable @typescript-eslint/no-explicit-any -- action-based route with validated body fields */
type Json = Record<string, any>;

const ok = (data: Json = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) => NextResponse.json({ ok: false, error: message }, { status });

function validateScheduledFor(raw: unknown, stepRaw: unknown): { iso: string | null; error: string | null } {
  if (raw === undefined) return { iso: null, error: null };
  if (raw === null || String(raw).trim() === "") return { iso: null, error: null };

  const dt = new Date(String(raw));
  if (Number.isNaN(dt.getTime())) return { iso: null, error: "Invalid scheduled date/time." };

  const rawStep = stepRaw === undefined ? 15 : Number(stepRaw);
  const step = Number.isFinite(rawStep) ? Math.max(1, Math.floor(rawStep)) : 15;
  if (dt.getMinutes() % step !== 0) {
    if (step === 15) {
      return { iso: null, error: "Tickets can only be scheduled at 15-minute intervals (XX:00, XX:15, XX:30, XX:45)." };
    }
    return { iso: null, error: `Tickets can only be scheduled at ${step}-minute intervals.` };
  }

  return { iso: dt.toISOString(), error: null };
}

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = await sql`select id from workspaces order by created_at asc limit 1`;
  return rows[0]?.id ?? null;
}

async function normalizeTicketPosition(sql: ReturnType<typeof getSql>, columnId: string) {
  const rows = await sql`select id from tickets where column_id=${columnId} order by position asc, created_at asc`;
  for (let i = 0; i < rows.length; i += 1) {
    await sql`update tickets set position=${i}, updated_at=now() where id=${rows[i].id}`;
  }
}

async function ensureTasksAgentId(sql: ReturnType<typeof getSql>, wid: string) {
  const existing = await sql`select id from agents where workspace_id=${wid} and openclaw_agent_id='tasks' limit 1`;
  if (existing[0]?.id) return existing[0].id as string;
  const inserted = await sql`
    insert into agents (workspace_id, openclaw_agent_id, status, model, last_heartbeat_at)
    values (${wid}, 'tasks', 'running', 'mission-control', now())
    returning id
  `;
  return inserted[0]?.id as string;
}

async function logTaskAudit(
  sql: ReturnType<typeof getSql>,
  wid: string,
  params: { event: string; details?: string; level?: "info" | "success" | "warning" | "error"; ticketId?: string | null; actor?: Actor },
) {
  const level = params.level || "info";
  const details = params.details || "";
  const actorName = params.actor?.name ?? null;
  const actorEmail = params.actor?.email ?? null;
  await sql`insert into activity_logs (workspace_id, source, event, details, level, actor_name, actor_email) values (${wid}, 'Tasks', ${params.event}, ${details}, ${level}, ${actorName}, ${actorEmail})`;

  if (params.ticketId) {
    const activityInsert = await sql`insert into ticket_activity (ticket_id, source, event, details, level, actor_name, actor_email) values (${params.ticketId}, 'Tasks', ${params.event}, ${details}, ${level}, ${actorName}, ${actorEmail}) returning id::text`;
    const activityId = activityInsert[0]?.id;
    if (activityId) {
      await sql`select pg_notify('ticket_activity', ${activityId})`;
    }
  }

  const tasksAgentId = await ensureTasksAgentId(sql, wid);
  const inserted = await sql`
    insert into agent_logs (
      workspace_id, agent_id, runtime_agent_id, occurred_at, level, type, message, event_type, message_preview, raw_payload
    ) values (
      ${wid}, ${tasksAgentId}, 'tasks', now(), ${level}, 'workflow', ${`${params.event}${details ? ` — ${details}` : ''}`}, 'task.event', ${`${params.event}${details ? ` — ${details}` : ''}`.slice(0, 240)}, ${JSON.stringify({ event: params.event, details, ticketId: params.ticketId || null, actor: { name: actorName, email: actorEmail } })}::jsonb
    ) returning id::text
  `;
  const insertedId = inserted[0]?.id;
  if (insertedId) {
    await sql`select pg_notify('agent_logs', ${insertedId})`;
  }
}

// Parse `@<assignee name>` mentions out of a comment body.
// Greedy match: prefer the longest matching board assignee name first so
// `@Alex Rivera` resolves to "Alex Rivera" not "Alex".
function extractMentions(
  content: string,
  assignees: Array<{ id: string; name: string; email: string }>,
): Array<{ id: string; name: string; email: string }> {
  const byLength = [...assignees].sort((a, b) => b.name.length - a.name.length);
  const seen = new Set<string>();
  const matched: Array<{ id: string; name: string; email: string }> = [];
  // Find every `@` token and try to match each assignee name at that position.
  const text = content;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "@") continue;
    if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) continue;
    const tail = text.slice(i + 1);
    for (const a of byLength) {
      if (!a.name) continue;
      if (tail.toLowerCase().startsWith(a.name.toLowerCase())) {
        const afterIdx = i + 1 + a.name.length;
        const after = text[afterIdx];
        // Must be terminated by non-word (or end of string).
        if (after === undefined || !/[A-Za-z0-9_]/.test(after)) {
          if (!seen.has(a.id)) {
            seen.add(a.id);
            matched.push(a);
          }
          i = afterIdx - 1;
          break;
        }
      }
    }
  }
  return matched;
}

async function hasTableColumn(sql: ReturnType<typeof getSql>, tableName: string, columnName: string): Promise<boolean> {
  const rows = await sql`
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = ${tableName}
      and column_name = ${columnName}
    limit 1
  `;
  return rows.length > 0;
}

async function getWorkerSettings(sql: ReturnType<typeof getSql>) {
  const hasSidebarActivityCount = await hasTableColumn(sql, "worker_settings", "sidebar_activity_count");

  const rows = hasSidebarActivityCount
    ? await sql`
        select enabled, poll_interval_seconds, max_concurrency, last_tick_at, agenda_concurrency, default_execution_window_minutes, auto_retry_after_minutes, max_retries, sidebar_activity_count, instance_name
        from worker_settings
        where id = 1
        limit 1
      `
    : await sql`
        select enabled, poll_interval_seconds, max_concurrency, last_tick_at, agenda_concurrency, default_execution_window_minutes, auto_retry_after_minutes, max_retries, instance_name
        from worker_settings
        where id = 1
        limit 1
      `;

  const row = rows[0] || {
    enabled: true,
    poll_interval_seconds: 20,
    max_concurrency: 3,
    last_tick_at: null,
    agenda_concurrency: 5,
    default_execution_window_minutes: 30,
    auto_retry_after_minutes: 0,
    max_retries: 1,
    sidebar_activity_count: 8,
    instance_name: "Mission Control",
  };

  return {
    enabled: Boolean(row.enabled),
    pollIntervalSeconds: Number(row.poll_interval_seconds || 20),
    maxConcurrency: Number(row.max_concurrency || 3),
    lastTickAt: row.last_tick_at ? String(row.last_tick_at) : null,
    agendaConcurrency: Number(row.agenda_concurrency || 5),
    defaultExecutionWindowMinutes: Number(row.default_execution_window_minutes || 30),
    autoRetryAfterMinutes: Number(row.auto_retry_after_minutes || 0),
    maxRetries: Number(row.max_retries ?? 1),
    sidebarActivityCount: Number(row.sidebar_activity_count ?? 8),
    instanceName: String(row.instance_name || "Mission Control"),
  };
}

export async function GET() {
  try {
    const sql = getSql();
    const wid = await workspaceId(sql);
    if (!wid) return ok({ boards: [], columns: [], tickets: [], workerSettings: { enabled: true, pollIntervalSeconds: 20, maxConcurrency: 3, lastTickAt: null } });

    const [boards, columns, tickets, boardAssignees, boardLabels, workerSettings] = await Promise.all([
      sql`select * from boards where workspace_id=${wid} order by created_at asc`,
      sql`select * from columns where board_id in (select id from boards where workspace_id=${wid}) order by position asc, created_at asc`,
      sql`select * from tickets where workspace_id=${wid} order by position asc, created_at asc`,
      sql`select * from board_assignees where board_id in (select id from boards where workspace_id=${wid}) order by name asc`.catch(() => []),
      sql`select * from board_labels where board_id in (select id from boards where workspace_id=${wid}) order by name asc`.catch(() => []),
      getWorkerSettings(sql),
    ]);

    return ok({ boards, columns, tickets, boardAssignees, boardLabels, workerSettings });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load tasks", 500);
  }
}

// Boot migrations run once per process to avoid flooding nextjs.log with
// Postgres NOTICE messages on every request. The canonical schema lives in
// db/schema.sql; these are best-effort self-heal mirrors.
let _tasksSchemaEnsured = false;

export async function POST(request: Request) {
  try {
    const sql = getSql();
    // ── Boot migrations (once per process) ─────────────────────────────────
    if (!_tasksSchemaEnsured) {
      // Boot migration: add checklist_name if not present
      await sql`ALTER TABLE ticket_subtasks ADD COLUMN IF NOT EXISTS checklist_name text NOT NULL DEFAULT 'Checklist'`;
    await sql`
      CREATE TABLE IF NOT EXISTS board_assignees (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        name text NOT NULL,
        color text NOT NULL DEFAULT '#94a3b8',
        initials text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (board_id, name)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS board_assignees_board_id_idx ON board_assignees(board_id)`;
    // Boot migration safety net for activity actor columns (also in db/schema.sql).
    await sql`ALTER TABLE ticket_activity ADD COLUMN IF NOT EXISTS actor_name text`;
    await sql`ALTER TABLE ticket_activity ADD COLUMN IF NOT EXISTS actor_email text`;
    await sql`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS actor_name text`;
    await sql`ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS actor_email text`;
    // board_assignees.email + notifications table — safety net mirrors of db/schema.sql
    await sql`ALTER TABLE board_assignees ADD COLUMN IF NOT EXISTS email text`;
    await sql`CREATE INDEX IF NOT EXISTS board_assignees_email_idx ON board_assignees(lower(email)) WHERE email IS NOT NULL`;
    await sql`
      CREATE TABLE IF NOT EXISTS notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        recipient_email text NOT NULL,
        recipient_sub text,
        kind text NOT NULL DEFAULT 'mention',
        actor_name text,
        actor_email text,
        board_id uuid REFERENCES boards(id) ON DELETE CASCADE,
        ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
        comment_id uuid REFERENCES ticket_comments(id) ON DELETE CASCADE,
        preview text NOT NULL DEFAULT '',
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx ON notifications(lower(recipient_email), created_at desc) WHERE read_at IS NULL`;
    await sql`CREATE INDEX IF NOT EXISTS notifications_recipient_recent_idx ON notifications(lower(recipient_email), created_at desc)`;
    // board_labels + tickets.label_ids — same idempotent shape as board_assignees.
    await sql`
      CREATE TABLE IF NOT EXISTS board_labels (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        name text NOT NULL,
        color text NOT NULL DEFAULT '#94a3b8',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (board_id, name)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS board_labels_board_id_idx ON board_labels(board_id)`;
    await sql`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS label_ids text[] NOT NULL DEFAULT '{}'::text[]`;
    await sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS board_assignees_migrated_at timestamptz`;
    const migRows = await sql`select board_assignees_migrated_at from app_settings where id = 1 limit 1`;
    if (!migRows[0]?.board_assignees_migrated_at) {
      await sql`update tickets set assignee_ids = '{}'::text[], updated_at = now() where assignee_ids <> '{}'::text[]`;
      await sql`update app_settings set board_assignees_migrated_at = now() where id = 1`;
    }
      _tasksSchemaEnsured = true;
    }
    const contentType = request.headers.get("content-type") || "";
    const isMultipart = contentType.includes("multipart/form-data");

    let action = "";
    let body: Json = {};
    let form: FormData | null = null;

    if (isMultipart) {
      form = await request.formData();
      action = String(form.get("action") || "");
    } else {
      body = (await request.json()) as Json;
      action = String(body.action || "");
    }

    const wid = await workspaceId(sql);
    if (!wid) return fail("Workspace not found", 500);

    // Resolve the current actor once for all audit/comment writes in this request.
    // proxy.ts gates /api/tasks behind auth — we still tolerate a missing session
    // (e.g. internal service calls) by writing nulls into the actor columns.
    const session = await getSession().catch(() => null);
    const actor: Actor = {
      name: session?.name?.trim() || null,
      email: session?.email?.trim() || null,
    };
    // Per-request audit binding so every write attributes to the logged-in user.
    const audit = (params: { event: string; details?: string; level?: "info" | "success" | "warning" | "error"; ticketId?: string | null }) =>
      logTaskAudit(sql, wid, { ...params, actor });

    const removedExecutionActions = new Set(["approvePlan", "rejectPlan", "startExecution", "retryExecution", "retryFromNeedsRetry"]);
    if (removedExecutionActions.has(action)) {
      return fail("Ticket agent execution has been removed from Boards.", 410);
    }

    if (action === "createBoard") {
      const name = String(body.name || "").trim();
      const description = String(body.description || "").trim();
      if (!name) return fail("Board name is required.");
      const rows = await sql`insert into boards (workspace_id, name, description) values (${wid}, ${name}, ${description || null}) returning *`;
      await audit({ event: 'Board created', details: name, level: 'success' });
      return ok({ board: rows[0] });
    }

    if (action === "updateBoard") {
      const boardId = String(body.boardId || "");
      const name = String(body.name || "").trim();
      const description = String(body.description || "").trim();
      if (!boardId || !name) return fail("Board id and name are required.");
      const rows = await sql`update boards set name=${name}, description=${description || null}, updated_at=now() where id=${boardId} returning *`;
      await audit({ event: 'Board updated', details: name, level: 'info' });
      return ok({ board: rows[0] });
    }

    if (action === "deleteBoard") {
      const boardId = String(body.boardId || "");
      if (!boardId) return fail("Board id is required.");
      await sql`delete from boards where id=${boardId}`;
      await audit({ event: 'Board deleted', details: boardId, level: 'warning' });
      return ok();
    }

    if (action === "createColumn") {
      const boardId = String(body.boardId || "");
      const title = String(body.title || "").trim();
      const colorKey = String(body.colorKey || "neutral");
      const isDefault = Boolean(body.isDefault);
      if (!boardId || !title) return fail("Board id and title are required.");
      const posRows = await sql`select coalesce(max(position), -1) + 1 as pos from columns where board_id=${boardId}`;
      const position = Number(posRows[0]?.pos ?? 0);
      const rows = await sql`insert into columns (board_id, title, color_key, is_default, position) values (${boardId}, ${title}, ${colorKey}, ${isDefault}, ${position}) returning *`;
      await audit({ event: 'List created', details: title, level: 'success' });
      await sql`select pg_notify('ticket_activity', ${`column:created:${rows[0]?.id || ''}`})`;
      return ok({ column: rows[0] });
    }

    if (action === "updateColumn") {
      const columnId = String(body.columnId || "");
      if (!columnId) return fail("Column id is required.");
      const rows = await sql`update columns set title=coalesce(${body.title || null}, title), color_key=coalesce(${body.colorKey || null}, color_key), is_default=coalesce(${body.isDefault ?? null}, is_default), updated_at=now() where id=${columnId} returning *`;
      const updatedCol = rows[0];
      if (updatedCol?.id) {
        await audit({ event: 'List updated', details: updatedCol.title || columnId, level: 'info' });
        await sql`select pg_notify('ticket_activity', ${`column:updated:${updatedCol.id}`})`;
      }
      return ok({ column: updatedCol });
    }

    if (action === "deleteColumn") {
      const columnId = String(body.columnId || "");
      if (!columnId) return fail("Column id is required.");
      await sql`delete from columns where id=${columnId}`;
      await audit({ event: 'List deleted', details: columnId, level: 'warning' });
      return ok();
    }

    if (action === "listBoardAssignees") {
      const boardId = String(body.boardId || "");
      if (!boardId) return fail("Board id is required.");
      const rows = await sql`select * from board_assignees where board_id=${boardId} order by name asc`;
      return ok({ assignees: rows });
    }

    if (action === "createBoardAssignee") {
      const boardId = String(body.boardId || "");
      const name = String(body.name || "").trim();
      const color = String(body.color || "#94a3b8").trim() || "#94a3b8";
      const email = body.email ? String(body.email).trim() || null : null;
      if (!boardId || !name) return fail("Board id and name are required.");
      const initials = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || "")
        .join("") || name.slice(0, 2).toUpperCase();
      try {
        const rows = await sql`
          insert into board_assignees (board_id, name, color, initials, email)
          values (${boardId}, ${name}, ${color}, ${initials}, ${email})
          returning *
        `;
        await audit({ event: 'Assignee added', details: `${name} on board ${boardId}`, level: 'success' });
        return ok({ assignee: rows[0] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("board_assignees_board_id_name_key") || msg.includes("duplicate key")) {
          return fail("An assignee with that name already exists on this board.");
        }
        throw err;
      }
    }

    if (action === "updateBoardAssignee") {
      const assigneeId = String(body.assigneeId || "");
      if (!assigneeId) return fail("Assignee id is required.");
      const rawName = body.name === undefined ? null : String(body.name).trim();
      const name = rawName === "" ? null : rawName;
      const color = body.color === undefined ? null : String(body.color).trim() || null;
      // For email an explicit empty string means "clear it"; undefined means "leave it".
      const emailProvided = body.email !== undefined;
      const emailValue = emailProvided ? (String(body.email || "").trim() || null) : null;
      const initials = name
        ? name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || name.slice(0, 2).toUpperCase()
        : null;
      const rows = await sql`
        update board_assignees
        set
          name = coalesce(${name}, name),
          color = coalesce(${color}, color),
          initials = coalesce(${initials}, initials),
          email = case when ${emailProvided} then ${emailValue} else email end,
          updated_at = now()
        where id = ${assigneeId}
        returning *
      `;
      await audit({ event: 'Assignee updated', details: rows[0]?.name || assigneeId, level: 'info' });
      return ok({ assignee: rows[0] });
    }

    if (action === "listBoardLabels") {
      const boardId = String(body.boardId || "");
      if (!boardId) return fail("Board id is required.");
      const rows = await sql`select * from board_labels where board_id=${boardId} order by name asc`;
      return ok({ labels: rows });
    }

    if (action === "createBoardLabel") {
      const boardId = String(body.boardId || "");
      const name = String(body.name || "").trim();
      const color = String(body.color || "#94a3b8").trim() || "#94a3b8";
      if (!boardId || !name) return fail("Board id and name are required.");
      try {
        const rows = await sql`
          insert into board_labels (board_id, name, color)
          values (${boardId}, ${name}, ${color})
          returning *
        `;
        await audit({ event: 'Label added', details: `${name} on board ${boardId}`, level: 'success' });
        return ok({ label: rows[0] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("board_labels_board_id_name_key") || msg.includes("duplicate key")) {
          return fail("A label with that name already exists on this board.");
        }
        throw err;
      }
    }

    if (action === "updateBoardLabel") {
      const labelId = String(body.labelId || "");
      if (!labelId) return fail("Label id is required.");
      const name = body.name !== undefined ? String(body.name).trim() || null : null;
      const color = body.color !== undefined ? String(body.color).trim() || null : null;
      const rows = await sql`
        update board_labels
        set name = coalesce(${name}, name),
            color = coalesce(${color}, color),
            updated_at = now()
        where id = ${labelId}
        returning *
      `;
      await audit({ event: 'Label updated', details: rows[0]?.name || labelId, level: 'info' });
      return ok({ label: rows[0] });
    }

    if (action === "deleteBoardLabel") {
      const labelId = String(body.labelId || "");
      if (!labelId) return fail("Label id is required.");
      await sql`update tickets set label_ids = array_remove(label_ids, ${labelId}), updated_at = now() where ${labelId} = ANY(label_ids)`;
      const rows = await sql`delete from board_labels where id=${labelId} returning name`;
      await audit({ event: 'Label removed', details: rows[0]?.name || labelId, level: 'warning' });
      return ok();
    }

    if (action === "deleteBoardAssignee") {
      const assigneeId = String(body.assigneeId || "");
      if (!assigneeId) return fail("Assignee id is required.");
      // Remove from all tickets that reference it on this board
      await sql`update tickets set assignee_ids = array_remove(assignee_ids, ${assigneeId}), updated_at = now() where ${assigneeId} = ANY(assignee_ids)`;
      const rows = await sql`delete from board_assignees where id=${assigneeId} returning name`;
      await audit({ event: 'Assignee removed', details: rows[0]?.name || assigneeId, level: 'warning' });
      return ok();
    }

    if (action === "listTicketDocuments") {
      if (!(await isModuleEnabled("documents"))) {
        // Graceful — return empty so ticket-modal UI hides itself without an error.
        return ok({ documents: [] });
      }
      const ticketId = String(body.ticketId || "");
      if (!ticketId) return fail("Ticket id is required.");
      // ticket_documents may not exist yet on a stale dev DB; create it on demand.
      await sql`
        CREATE TABLE IF NOT EXISTS ticket_documents (
          ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          linked_by_email text,
          linked_by_name text,
          linked_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (ticket_id, document_id)
        )
      `.catch(() => null);
      const rows = await sql`
        select
          d.id::text,
          d.relative_path,
          d.kind,
          d.size_bytes,
          d.extension,
          d.last_edited_by_name,
          d.last_edited_by_email,
          d.updated_at,
          td.linked_by_name,
          td.linked_at
        from ticket_documents td
        join documents d on d.id = td.document_id
        where td.ticket_id = ${ticketId}
        order by td.linked_at desc
      `.catch(() => []);
      return ok({ documents: rows });
    }

    if (action === "linkTicketDocument") {
      if (!(await isModuleEnabled("documents"))) {
        return fail("Documents module is disabled. Enable it in Settings to link documents.", 503);
      }
      const ticketId = String(body.ticketId || "");
      const documentId = String(body.documentId || "");
      if (!ticketId || !documentId) return fail("Ticket id and document id are required.");
      const docRows = await sql`select relative_path from documents where id = ${documentId} limit 1`;
      const docPath = docRows[0]?.relative_path as string | undefined;
      if (!docPath) return fail("Document not found.", 404);
      await sql`
        insert into ticket_documents (ticket_id, document_id, linked_by_email, linked_by_name)
        values (${ticketId}, ${documentId}, ${actor.email}, ${actor.name})
        on conflict (ticket_id, document_id) do nothing
      `;
      await audit({
        event: 'Document linked',
        details: docPath,
        level: 'success',
        ticketId,
      });
      // Mirror to document_audit so the doc's History tab knows.
      await sql`
        insert into document_audit (document_id, workspace_id, actor_email, actor_name, event, details)
        values (${documentId}, ${wid}, ${actor.email}, ${actor.name}, 'linked_to_ticket', ${JSON.stringify({ ticketId, path: docPath })}::jsonb)
      `.catch(() => null);
      return ok();
    }

    if (action === "unlinkTicketDocument") {
      // Allow unlink even when module disabled? No — if module is off, the link
      // table is already gone via the FK cascade. Be silent on success.
      if (!(await isModuleEnabled("documents"))) {
        return ok();
      }
      const ticketId = String(body.ticketId || "");
      const documentId = String(body.documentId || "");
      if (!ticketId || !documentId) return fail("Ticket id and document id are required.");
      const docRows = await sql`select relative_path from documents where id = ${documentId} limit 1`;
      const docPath = (docRows[0]?.relative_path as string | undefined) || documentId;
      await sql`delete from ticket_documents where ticket_id = ${ticketId} and document_id = ${documentId}`;
      await audit({
        event: 'Document unlinked',
        details: docPath,
        level: 'info',
        ticketId,
      });
      await sql`
        insert into document_audit (document_id, workspace_id, actor_email, actor_name, event, details)
        values (${documentId}, ${wid}, ${actor.email}, ${actor.name}, 'unlinked_from_ticket', ${JSON.stringify({ ticketId, path: docPath })}::jsonb)
      `.catch(() => null);
      return ok();
    }

    if (action === "reorderColumns") {
      const orderedColumnIds = Array.isArray(body.orderedColumnIds) ? body.orderedColumnIds : [];
      for (let i = 0; i < orderedColumnIds.length; i += 1) {
        await sql`update columns set position=${i}, updated_at=now() where id=${String(orderedColumnIds[i])}`;
      }
      return ok();
    }

    if (action === "createTicket") {
      const boardId = String(body.boardId || "");
      const columnId = String(body.columnId || "");
      const title = String(body.title || "").trim();
      if (!boardId || !columnId || !title) return fail("Board, column and title are required.");

      const posRows = await sql`select coalesce(max(position), -1) + 1 as pos from tickets where column_id=${columnId}`;
      const position = Number(posRows[0]?.pos ?? 0);
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
      const assigneeIds = Array.isArray(body.assigneeIds) ? body.assigneeIds.map(String) : [];
      const labelIds = Array.isArray(body.labelIds) ? body.labelIds.map(String) : [];
      const scheduled = validateScheduledFor(body.scheduledFor, body.timeStepMinutes);
      if (scheduled.error) return fail(scheduled.error);

      const rows = await sql`
        insert into tickets (
          workspace_id, board_id, column_id, title, description, priority, due_date,
          tags, assignee_ids, label_ids, assigned_agent_id, execution_mode, plan_text, plan_approved, scheduled_for,
          checklist_done, checklist_total, comments_count, attachments_count, position, telegram_chat_id,
          execution_window_minutes, fallback_model
        ) values (
          ${wid}, ${boardId}, ${columnId}, ${title}, ${String(body.description || "")}, ${String(body.priority || "low")}, ${body.dueDate || null},
          ${sql.array(tags)}, ${sql.array(assigneeIds)}, ${sql.array(labelIds)}, '', 'auto', '', false, ${scheduled.iso},
          ${Number(body.checklistDone || 0)}, ${Number(body.checklistTotal || 0)}, ${Number(body.commentsCount || 0)}, ${Number(body.attachmentsCount || 0)}, ${position}, ${body.telegramChatId || null},
          60, ''
        )
        returning *
      `;
      const created = rows[0];
      if (created?.id) {
        await audit({ event: 'Ticket created', details: created.title || title, level: 'success' });
      }
      return ok({ ticket: created });
    }

    if (action === "updateTicket") {
      const ticketId = String(body.ticketId || "");
      if (!ticketId) return fail("Ticket id is required.");
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
      const assigneeIds = Array.isArray(body.assigneeIds) ? body.assigneeIds.map(String) : [];
      const labelIds = Array.isArray(body.labelIds) ? body.labelIds.map(String) : [];

      const beforeRows = await sql`select * from tickets where id=${ticketId} limit 1`;
      const before = beforeRows[0];
      if (!before) return fail("Ticket not found.", 404);

      let scheduledIsoForUpdate: string | null = null;
      if (body.scheduledFor !== undefined) {
        const scheduled = validateScheduledFor(body.scheduledFor, body.timeStepMinutes);
        if (scheduled.error) return fail(scheduled.error);
        scheduledIsoForUpdate = scheduled.iso;
      }

      const rows = await sql`
        update tickets
        set
          column_id = coalesce(${body.columnId || null}, column_id),
          title = coalesce(${body.title || null}, title),
          description = coalesce(${body.description ?? null}, description),
          priority = coalesce(${body.priority || null}, priority),
          due_date = case when ${body.dueDate === undefined} then due_date else ${body.dueDate ?? null} end,
          tags = case when ${body.tags === undefined} then tags else ${sql.array(tags)} end,
          assignee_ids = case when ${body.assigneeIds === undefined} then assignee_ids else ${sql.array(assigneeIds)} end,
          label_ids = case when ${body.labelIds === undefined} then label_ids else ${sql.array(labelIds)} end,
          scheduled_for = case when ${body.scheduledFor === undefined} then scheduled_for else ${scheduledIsoForUpdate} end,
          checklist_done = coalesce(${body.checklistDone ?? null}, checklist_done),
          checklist_total = coalesce(${body.checklistTotal ?? null}, checklist_total),
          comments_count = coalesce(${body.commentsCount ?? null}, comments_count),
          attachments_count = coalesce(${body.attachmentsCount ?? null}, attachments_count),
          updated_at = now()
        where id = ${ticketId}
        returning *
      `;
      const updated = rows[0];
      if (updated?.id) {
        await audit({
          event: 'Ticket updated',
          details: updated.title || String(body.title || '') || ticketId,
          level: 'info',
          ticketId: updated.id,
        });
      }
      return ok({ ticket: updated });
    }

    if (action === "deleteTicket") {
      const ticketId = String(body.ticketId || "");
      if (!ticketId) return fail("Ticket id is required.");
      await sql`delete from tickets where id=${ticketId}`;
      // Note: ticket_activity entry is created by the UI hook — only log to activity_logs/agent_logs here
      await audit({ event: 'Ticket deleted', details: ticketId, level: 'warning' });
      return ok();
    }

    if (action === "moveTicket") {
      const ticketId = String(body.ticketId || "");
      const toColumnId = String(body.toColumnId || "");
      const beforeTicketId = body.beforeTicketId ? String(body.beforeTicketId) : null;
      if (!ticketId || !toColumnId) return fail("Ticket id and destination column are required.");

      const ticketRows = await sql`select id, column_id from tickets where id=${ticketId} limit 1`;
      const current = ticketRows[0];
      if (!current) return fail("Ticket not found", 404);

      await sql`update tickets set column_id=${toColumnId}, updated_at=now() where id=${ticketId}`;
      const fromColRows = await sql`select title from columns where id=${String(current.column_id)} limit 1`;
      const toColRows = await sql`select title from columns where id=${toColumnId} limit 1`;
      const fromColTitle = String(fromColRows[0]?.title || 'Unknown');
      const toColTitle = String(toColRows[0]?.title || 'Unknown');
      await audit({ event: 'Moved ticket', details: `Moved from ${fromColTitle} to ${toColTitle}.`, level: 'info', ticketId });

      if (beforeTicketId) {
        const beforeRows = await sql`select position from tickets where id=${beforeTicketId} limit 1`;
        const targetPos = Number(beforeRows[0]?.position ?? 0);
        await sql`update tickets set position = position + 1 where column_id=${toColumnId} and id <> ${ticketId} and position >= ${targetPos}`;
        await sql`update tickets set position=${targetPos} where id=${ticketId}`;
      } else {
        const maxRows = await sql`select coalesce(max(position), -1) + 1 as pos from tickets where column_id=${toColumnId} and id <> ${ticketId}`;
        await sql`update tickets set position=${Number(maxRows[0]?.pos ?? 0)} where id=${ticketId}`;
      }

      await normalizeTicketPosition(sql, String(current.column_id));
      await normalizeTicketPosition(sql, toColumnId);
      return ok();
    }

    if (action === "reorderTickets") {
      const columnId = String(body.columnId || "");
      const orderedTicketIds = Array.isArray(body.orderedTicketIds) ? body.orderedTicketIds : [];
      if (!columnId) return fail("Column id is required.");
      for (let i = 0; i < orderedTicketIds.length; i += 1) {
        await sql`update tickets set position=${i}, updated_at=now() where id=${String(orderedTicketIds[i])} and column_id=${columnId}`;
      }
      return ok();
    }

    if (action === "listTicketAttachments") {
      const ticketId = String(body.ticketId || "");
      const rows = await sql`select * from ticket_attachments where ticket_id=${ticketId} order by created_at desc`;
      return ok({ rows });
    }

    if (action === "uploadAttachment" && form) {
      const ticketId = String(form.get("ticketId") || "");
      const file = form.get("file");
      if (!ticketId || !(file instanceof File)) return fail("Ticket and file are required.");
      // Reject HTML/SVG outright (script-execution vectors when later opened).
      // Other types are size-capped to keep one ticket from blowing up the row.
      const declaredType = (file.type || "application/octet-stream").toLowerCase();
      if (
        declaredType === "text/html" ||
        declaredType === "application/xhtml+xml" ||
        declaredType === "image/svg+xml" ||
        file.name.toLowerCase().endsWith(".html") ||
        file.name.toLowerCase().endsWith(".htm") ||
        file.name.toLowerCase().endsWith(".svg")
      ) {
        return fail("HTML/SVG attachments are not allowed.", 415);
      }
      const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
      if (file.size > MAX_UPLOAD_BYTES) {
        return fail(`File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`, 413);
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return fail(`File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`, 413);
      }
      const mimeType = declaredType;
      const base64 = buffer.toString("base64");
      const url = `data:${mimeType};base64,${base64}`;

      const rows = await sql`
        insert into ticket_attachments (ticket_id, name, url, mime_type, size, path)
        values (${ticketId}, ${file.name}, ${url}, ${mimeType}, ${buffer.length}, 'inline')
        returning *
      `;
      await sql`update tickets set attachments_count = coalesce((select count(*) from ticket_attachments where ticket_id=${ticketId}), 0), updated_at=now() where id=${ticketId}`;
      return ok({ attachment: rows[0] });
    }

    if (action === "attachFileFromPath") {
      // Attach a local file by its path. Gated by isAllowedAttachmentPath which
      // restricts to documents/, runtime-artifacts/, storage/, /tmp/ and denies
      // .env / secrets / ssh keys regardless of root.
      const ticketId = String(body.ticketId || "");
      const filePath = String(body.filePath || "");
      if (!ticketId || !filePath) return fail("Ticket id and file path are required.");

      const { isAllowedAttachmentPath } = await import("@/app/api/files/route");
      if (!isAllowedAttachmentPath(filePath)) {
        return fail("That path is not allowed as an attachment source.", 403);
      }
      const fs = await import("node:fs");
      const path = await import("node:path");
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return fail("File not found or is not a file.");
      }

      const fileName = path.basename(resolved);
      const fileSize = fs.statSync(resolved).size;
      const ext = path.extname(resolved).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
        ".csv": "text/csv", ".pdf": "application/pdf", ".html": "text/html",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
        ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip",
        ".ts": "text/typescript", ".js": "text/javascript", ".py": "text/x-python",
        ".sh": "text/x-shellscript", ".log": "text/plain", ".yaml": "application/x-yaml",
        ".yml": "application/x-yaml", ".xml": "application/xml", ".sql": "application/sql",
        ".css": "text/css", ".rs": "text/x-rust", ".go": "text/x-go",
      };
      const mimeType = mimeMap[ext] || "application/octet-stream";
      const url = `/api/files?path=${encodeURIComponent(resolved)}`;

      const rows = await sql`
        insert into ticket_attachments (ticket_id, name, url, mime_type, size, path)
        values (${ticketId}, ${fileName}, ${url}, ${mimeType}, ${fileSize}, ${resolved})
        returning *
      `;
      await sql`update tickets set attachments_count = coalesce((select count(*) from ticket_attachments where ticket_id=${ticketId}), 0), updated_at=now() where id=${ticketId}`;
      return ok({ attachment: rows[0] });
    }

    if (action === "deleteAttachment") {
      const attachmentId = String(body.attachmentId || "");
      const rows = await sql`delete from ticket_attachments where id=${attachmentId} returning ticket_id`;
      const ticketId = rows[0]?.ticket_id;
      if (ticketId) {
        await sql`update tickets set attachments_count = coalesce((select count(*) from ticket_attachments where ticket_id=${ticketId}), 0), updated_at=now() where id=${ticketId}`;
      }
      return ok();
    }

    if (action === "listTicketSubtasks") {
      const ticketId = String(body.ticketId || "");
      const rows = await sql`select * from ticket_subtasks where ticket_id=${ticketId} order by position asc, created_at asc`;
      return ok({ rows });
    }

    if (action === "createSubtask") {
      const ticketId = String(body.ticketId || "");
      const title = String(body.title || "").trim();
      const checklistName = String(body.checklistName || "Checklist").trim() || "Checklist";
      if (!ticketId || !title) return fail("Ticket and title are required.");
      const posRows = await sql`select coalesce(max(position), -1) + 1 as pos from ticket_subtasks where ticket_id=${ticketId} and checklist_name=${checklistName}`;
      const rows = await sql`insert into ticket_subtasks (ticket_id, title, position, checklist_name) values (${ticketId}, ${title}, ${Number(posRows[0]?.pos ?? 0)}, ${checklistName}) returning *`;
      return ok({ subtask: rows[0] });
    }

    if (action === "updateSubtask") {
      const subtaskId = String(body.subtaskId || "");
      const checklistName = body.checklistName != null ? String(body.checklistName).trim() || null : null;
      const rows = await sql`update ticket_subtasks set title=coalesce(${body.title || null}, title), completed=coalesce(${body.completed ?? null}, completed), checklist_name=coalesce(${checklistName}, checklist_name), updated_at=now() where id=${subtaskId} returning *`;
      return ok({ subtask: rows[0] });
    }

    if (action === "deleteSubtask") {
      const subtaskId = String(body.subtaskId || "");
      await sql`delete from ticket_subtasks where id=${subtaskId}`;
      return ok();
    }

    if (action === "renameChecklistItems") {
      const ticketId = String(body.ticketId || "");
      const oldName = String(body.oldName || "").trim();
      const newName = String(body.newName || "").trim();
      if (!ticketId || !oldName || !newName) return fail("ticketId, oldName, and newName are required.");
      await sql`update ticket_subtasks set checklist_name=${newName}, updated_at=now() where ticket_id=${ticketId} and checklist_name=${oldName}`;
      return ok();
    }

    if (action === "deleteChecklistItems") {
      const ticketId = String(body.ticketId || "");
      const checklistName = String(body.checklistName || "").trim();
      if (!ticketId || !checklistName) return fail("ticketId and checklistName are required.");
      await sql`delete from ticket_subtasks where ticket_id=${ticketId} and checklist_name=${checklistName}`;
      return ok();
    }

    if (action === "listTicketComments") {
      const ticketId = String(body.ticketId || "");
      const rows = await sql`select * from ticket_comments where ticket_id=${ticketId} order by created_at asc`;
      return ok({ rows });
    }

    if (action === "createComment") {
      const ticketId = String(body.ticketId || "");
      const content = String(body.content || "").trim();
      if (!ticketId || !content) return fail("Ticket and content are required.");
      const authorName = actor.name || "Operator";
      const authorId = session?.sub || null;
      const commentRows = await sql`insert into ticket_comments (ticket_id, author_id, author_name, content) values (${ticketId}, ${authorId}, ${authorName}, ${content}) returning *`;
      const comment = commentRows[0];
      await sql`update tickets set comments_count = coalesce((select count(*) from ticket_comments where ticket_id=${ticketId}), 0), updated_at=now() where id=${ticketId}`;

      // Resolve the ticket's board so we know which assignees are eligible to be mentioned.
      const ticketCtx = await sql`select board_id from tickets where id=${ticketId} limit 1`;
      const boardId = ticketCtx[0]?.board_id as string | undefined;
      if (boardId) {
        const boardAssignees = await sql`
          select id, name, email from board_assignees
          where board_id = ${boardId} and email is not null and email <> ''
        ` as Array<{ id: string; name: string; email: string }>;
        const mentioned = extractMentions(content, boardAssignees);
        // Don't notify yourself when you @ yourself.
        const selfEmail = actor.email?.toLowerCase() || null;
        const preview = content.length > 240 ? `${content.slice(0, 237)}...` : content;
        for (const target of mentioned) {
          if (selfEmail && target.email.toLowerCase() === selfEmail) continue;
          const notifInsert = await sql`
            insert into notifications (
              workspace_id, recipient_email, recipient_sub, kind,
              actor_name, actor_email, board_id, ticket_id, comment_id, preview
            ) values (
              ${wid}, ${target.email}, ${null}, 'mention',
              ${actor.name}, ${actor.email}, ${boardId}, ${ticketId}, ${comment?.id || null}, ${preview}
            )
            returning id::text
          `;
          const notifId = notifInsert[0]?.id;
          if (notifId) {
            await sql`select pg_notify('notification', ${notifId})`;
          }
        }
      }

      return ok({ comment });
    }

    if (action === "deleteComment") {
      const commentId = String(body.commentId || "");
      const rows = await sql`delete from ticket_comments where id=${commentId} returning ticket_id`;
      const ticketId = rows[0]?.ticket_id;
      if (ticketId) {
        await sql`update tickets set comments_count = coalesce((select count(*) from ticket_comments where ticket_id=${ticketId}), 0), updated_at=now() where id=${ticketId}`;
      }
      return ok();
    }

    if (action === "listTicketActivity") {
      const ticketId = String(body.ticketId || "");
      const rows = await sql`select * from ticket_activity where ticket_id=${ticketId} order by occurred_at desc`;
      return ok({ rows });
    }

    if (action === "listBoardActivity") {
      const boardId = String(body.boardId || "");
      const limit = Math.min(Math.max(Number(body.limit || 15), 1), 100);
      if (!boardId) return fail("Board id is required.");
      const rows = await sql`
        select
          ta.id,
          ta.ticket_id,
          ta.source,
          ta.event,
          ta.details,
          ta.level,
          ta.actor_name,
          ta.actor_email,
          ta.occurred_at,
          t.title as ticket_title
        from ticket_activity ta
        join tickets t on t.id = ta.ticket_id
        where t.board_id = ${boardId}
        order by ta.occurred_at desc
        limit ${limit}
      `;

      // Deterministic UTC formatting (no locale)
      const pad = (n: number) => String(n).padStart(2, "0");
      const formatDT = (dateStr: string | null) => {
        if (!dateStr) return "";
        try {
          const d = new Date(dateStr);
          const y = d.getUTCFullYear();
          const mo = pad(d.getUTCMonth() + 1);
          const day = pad(d.getUTCDate());
          const h = pad(d.getUTCHours());
          const min = pad(d.getUTCMinutes());
          return `${mo}/${day}/${y}, ${h}:${min} UTC`;
        } catch {
          return "";
        }
      };

      const formattedRows = rows.map(r => ({
        ...r,
        occurred_at_formatted: formatDT(r.occurred_at),
      }));
      return ok({ rows: formattedRows });
    }

    if (action === "createActivity") {
      const ticketId = String(body.ticketId || "");
      const event = String(body.event || "").trim();
      if (!ticketId || !event) return fail("Ticket and event are required.");
      const rows = await sql`
        insert into ticket_activity (ticket_id, source, event, details, level)
        values (${ticketId}, ${String(body.source || 'Tasks')}, ${event}, ${String(body.details || '')}, ${String(body.level || 'info')})
        returning *
      `;
      const inserted = rows[0];
      if (inserted?.id) {
        await sql`select pg_notify('ticket_activity', ${inserted.id})`;
      }
      return ok({ activity: rows[0] });
    }

    if (action === "getWorkerSettings") {
      const workerSettings = await getWorkerSettings(sql);
      return ok({ workerSettings });
    }

    if (action === "updateWorkerSettings") {
      const enabled = body.enabled === undefined ? null : Boolean(body.enabled);
      const pollIntervalSeconds = body.pollIntervalSeconds === undefined ? null : Number(body.pollIntervalSeconds);
      const maxConcurrency = body.maxConcurrency === undefined ? null : Number(body.maxConcurrency);
      const agendaConcurrency = body.agendaConcurrency === undefined ? null : Number(body.agendaConcurrency);
      const defaultExecutionWindowMinutes = body.defaultExecutionWindowMinutes === undefined ? null : Number(body.defaultExecutionWindowMinutes);
      const autoRetryAfterMinutes = body.autoRetryAfterMinutes === undefined ? null : Number(body.autoRetryAfterMinutes);
      const maxRetries = body.maxRetries === undefined ? null : Number(body.maxRetries);
      const sidebarActivityCount = body.sidebarActivityCount === undefined ? null : Number(body.sidebarActivityCount);
      const instanceName = body.instanceName === undefined ? null : String(body.instanceName || "").trim();

      if (pollIntervalSeconds !== null && (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds < 5 || pollIntervalSeconds > 300)) {
        return fail("pollIntervalSeconds must be between 5 and 300");
      }
      if (maxConcurrency !== null && (!Number.isFinite(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 20)) {
        return fail("maxConcurrency must be between 1 and 20");
      }
      if (agendaConcurrency !== null && (!Number.isFinite(agendaConcurrency) || agendaConcurrency < 1 || agendaConcurrency > 10)) {
        return fail("agendaConcurrency must be between 1 and 10");
      }
      if (defaultExecutionWindowMinutes !== null && (!Number.isFinite(defaultExecutionWindowMinutes) || defaultExecutionWindowMinutes < 1 || defaultExecutionWindowMinutes > 1440)) {
        return fail("defaultExecutionWindowMinutes must be between 1 and 1440");
      }
      if (autoRetryAfterMinutes !== null && (!Number.isFinite(autoRetryAfterMinutes) || autoRetryAfterMinutes < 0 || autoRetryAfterMinutes > 1440)) {
        return fail("autoRetryAfterMinutes must be between 0 and 1440");
      }
      if (maxRetries !== null && (!Number.isFinite(maxRetries) || maxRetries < 0 || maxRetries > 5)) {
        return fail("maxRetries must be between 0 and 5");
      }
      if (sidebarActivityCount !== null && (!Number.isFinite(sidebarActivityCount) || sidebarActivityCount < 1 || sidebarActivityCount > 30)) {
        return fail("sidebarActivityCount must be between 1 and 30");
      }
      if (instanceName !== null && instanceName.length > 80) {
        return fail("instanceName must be 80 characters or less");
      }

      const hasSidebarActivityCount = await hasTableColumn(sql, "worker_settings", "sidebar_activity_count");

      if (hasSidebarActivityCount) {
        await sql`
          insert into worker_settings (id, enabled, poll_interval_seconds, max_concurrency, agenda_concurrency, default_execution_window_minutes, auto_retry_after_minutes, max_retries, sidebar_activity_count, instance_name)
          values (1, coalesce(${enabled}, true), coalesce(${pollIntervalSeconds}, 20), coalesce(${maxConcurrency}, 3), coalesce(${agendaConcurrency}, 5), coalesce(${defaultExecutionWindowMinutes}, 30), coalesce(${autoRetryAfterMinutes}, 0), coalesce(${maxRetries}, 1), coalesce(${sidebarActivityCount}, 8), coalesce(nullif(${instanceName}, ''), 'Mission Control'))
          on conflict (id) do update
            set enabled = coalesce(${enabled}, worker_settings.enabled),
                poll_interval_seconds = coalesce(${pollIntervalSeconds}, worker_settings.poll_interval_seconds),
                max_concurrency = coalesce(${maxConcurrency}, worker_settings.max_concurrency),
                agenda_concurrency = coalesce(${agendaConcurrency}, worker_settings.agenda_concurrency),
                default_execution_window_minutes = coalesce(${defaultExecutionWindowMinutes}, worker_settings.default_execution_window_minutes),
                auto_retry_after_minutes = coalesce(${autoRetryAfterMinutes}, worker_settings.auto_retry_after_minutes),
                max_retries = coalesce(${maxRetries}, worker_settings.max_retries),
                sidebar_activity_count = coalesce(${sidebarActivityCount}, worker_settings.sidebar_activity_count),
                instance_name = coalesce(nullif(${instanceName}, ''), worker_settings.instance_name),
                updated_at = now()
        `;
      } else {
        await sql`
          insert into worker_settings (id, enabled, poll_interval_seconds, max_concurrency, agenda_concurrency, default_execution_window_minutes, auto_retry_after_minutes, max_retries, instance_name)
          values (1, coalesce(${enabled}, true), coalesce(${pollIntervalSeconds}, 20), coalesce(${maxConcurrency}, 3), coalesce(${agendaConcurrency}, 5), coalesce(${defaultExecutionWindowMinutes}, 30), coalesce(${autoRetryAfterMinutes}, 0), coalesce(${maxRetries}, 1), coalesce(nullif(${instanceName}, ''), 'Mission Control'))
          on conflict (id) do update
            set enabled = coalesce(${enabled}, worker_settings.enabled),
                poll_interval_seconds = coalesce(${pollIntervalSeconds}, worker_settings.poll_interval_seconds),
                max_concurrency = coalesce(${maxConcurrency}, worker_settings.max_concurrency),
                agenda_concurrency = coalesce(${agendaConcurrency}, worker_settings.agenda_concurrency),
                default_execution_window_minutes = coalesce(${defaultExecutionWindowMinutes}, worker_settings.default_execution_window_minutes),
                auto_retry_after_minutes = coalesce(${autoRetryAfterMinutes}, worker_settings.auto_retry_after_minutes),
                max_retries = coalesce(${maxRetries}, worker_settings.max_retries),
                instance_name = coalesce(nullif(${instanceName}, ''), worker_settings.instance_name),
                updated_at = now()
        `;
      }

      const workerSettings = await getWorkerSettings(sql);
      await audit({
        event: "Worker settings updated",
        details: `enabled=${workerSettings.enabled}, interval=${workerSettings.pollIntervalSeconds}s, concurrency=${workerSettings.maxConcurrency}`,
        level: "info",
      });
      return ok({ workerSettings });
    }

    return fail(`Unsupported action: ${action}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Task operation failed", 500);
  }
}
