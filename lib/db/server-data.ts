import { getSql } from "@/lib/local-db";
import { collectRuntimeSnapshots } from "@/lib/runtime/collector";
import type { CollectorResult } from "@/lib/runtime/collector";
import { mergeAgentWithRuntime } from "@/lib/runtime/merge";
import type { AgentHealthActivity, AgentLogPageInfo, AgentStatus } from "@/types/agents";
import type { BoardHydration, BoardState, Column, Ticket, TicketPriority } from "@/types/tasks";

type BoardRow = { id: string; workspace_id: string; name: string; description: string | null };
type ColumnRow = { id: string; board_id: string; title: string; color_key: string | null; is_default: boolean | null; position: number | null };
type TicketRow = {
  id: string;
  workspace_id: string;
  board_id: string;
  column_id: string;
  title: string;
  description: string | null;
  priority: string | null;
  due_date: string | null;
  tags: string[] | null;
  label_ids: string[] | null;
  assignee_ids: string[] | null;
  assigned_agent_id: string | null;
  auto_approve: boolean | null;
  execution_mode: string | null;
  plan_text: string | null;
  plan_approved: boolean | null;
  scheduled_for: string | null;
  execution_state: string | null;
  checklist_done: number | null;
  checklist_total: number | null;
  comments_count: number | null;
  attachments_count: number | null;
  position: number | null;
  created_at: string;
  updated_at: string;
};
function emptyBoardState(): BoardState {
  return { columns: {}, columnOrder: [], tickets: {}, ticketIdsByColumn: {} } as BoardState;
}

export async function getSetupStatus(): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`select setup_completed from app_settings where id = 1 limit 1`;
  const row = rows[0] ?? { setup_completed: true };
  return Boolean(row.setup_completed ?? true);
}

export async function getSidebarUser() {
  return null;
}

export async function getWorkspaceAssignees() {
  const result: CollectorResult = await collectRuntimeSnapshots().catch(() => ({ snapshots: {}, assignees: [] }));
  return result.assignees.map((a) => ({
    id: a.id,
    name: a.name,
    initials: a.initials,
    color: a.color,
    source: "runtime" as const,
  }));
}

export async function getAgentsAndLogsData() {
  const result: CollectorResult = await collectRuntimeSnapshots().catch(() => ({ snapshots: {}, assignees: [] }));
  const { snapshots } = result;
  const agents = Object.values(snapshots)
    .filter((snapshot) => snapshot && snapshot.agentId)
    .map((snapshot) => ({
      id: snapshot.agentId,
      name: snapshot.identity?.name || snapshot.name || snapshot.agentId,
      status: (snapshot.status === "running" || snapshot.status === "degraded" ? snapshot.status : "idle") as AgentStatus,
      runtime: {
        model: snapshot.model ?? null,
        queueDepth: snapshot.queueDepth ?? null,
        activeRuns: snapshot.activeRuns ?? null,
        lastHeartbeatAt: snapshot.lastHeartbeatAt ?? null,
        uptimeMinutes: snapshot.uptimeMinutes ?? null,
      },
    }));

  const logs: unknown[] = [];
  const mergedAgents = agents.map((agent) => mergeAgentWithRuntime(agent, snapshots));
  return {
    agents: mergedAgents,
    logs,
    pageInfo: {
      limit: 200,
      page: 1,
      shownCount: 0,
      totalCount: 0,
      pageCount: 1,
    } satisfies AgentLogPageInfo,
    logTotals: { total: 0, info: 0, warning: 0, error: 0 },
  };
}

export async function getAgentDetailsData(agentId?: string) {
  const data = await getAgentsAndLogsData();
  const agent = agentId
    ? data.agents.find((a) => a.id === agentId) ?? data.agents[0] ?? null
    : data.agents[0] ?? null;
  return {
    agent,
    logs: data.logs,
    pageInfo: data.pageInfo,
    healthActivity: {
      lastActivityAt: null,
      responses1h: 0,
      errors1h: 0,
    } satisfies AgentHealthActivity,
    queueSummary: { assigned: 0, queued: 0, running: 0, blockedBySchedule: 0, blockedByApproval: 0, nextUp: [] },
  };
}

function toTone(colorKey: string | null): Column["tone"] {
  if (colorKey === "success" || colorKey === "emerald") return "success";
  if (colorKey === "warning" || colorKey === "amber") return "warning";
  if (colorKey === "info" || colorKey === "blue") return "info";
  return "neutral";
}

export async function getBoardsPageData(): Promise<BoardHydration[]> {
  const sql = getSql();
  const workspace = await sql`select id from workspaces order by created_at asc limit 1`;
  const wid = workspace[0]?.id ?? null;

  const boards = wid
    ? await sql<BoardRow[]>`select id, workspace_id, name, description from boards where workspace_id = ${wid} order by created_at asc`
    : [];
  const columns = wid
    ? await sql<ColumnRow[]>`select id, board_id, title, color_key, is_default, position from columns order by position asc, created_at asc`
    : [];
  const tickets = wid
    ? await sql<TicketRow[]>`select * from tickets where workspace_id = ${wid} order by position asc, created_at asc`
    : [];

  return boards.map((board) => {
    const boardColumns = columns.filter((column) => column.board_id === board.id);
    const boardTickets = tickets.filter((ticket) => ticket.board_id === board.id);

    const state: BoardState = emptyBoardState();

    for (const column of boardColumns) {
      state.columns[column.id] = {
        id: column.id,
        title: column.title,
        tone: toTone(column.color_key),
        isDefault: Boolean(column.is_default),
      } as Column;
      state.columnOrder.push(column.id);
      state.ticketIdsByColumn[column.id] = [];
    }

    for (const ticket of boardTickets) {
      const record = {
        id: ticket.id,
        title: ticket.title,
        description: ticket.description ?? "",
        statusId: ticket.column_id,
        priority: (ticket.priority ?? "medium") as TicketPriority,
        dueDate: ticket.due_date,
        tags: ticket.tags ?? [],
        labelIds: ticket.label_ids ?? [],
        assigneeIds: ticket.assignee_ids ?? [],
        assignedAgentId: ticket.assigned_agent_id ?? "",
        executionMode: (ticket.execution_mode as Ticket["executionMode"]) ?? "direct",
        planText: ticket.plan_text ?? "",
        planApproved: Boolean(ticket.plan_approved),
        scheduledFor: ticket.scheduled_for ? ticket.scheduled_for.slice(0, 10) : null,
        executionState: (ticket.execution_state as Ticket["executionState"]) ?? "open",
        checklistDone: ticket.checklist_done ?? 0,
        checklistTotal: ticket.checklist_total ?? 0,
        comments: ticket.comments_count ?? 0,
        attachments: ticket.attachments_count ?? 0,
        createdAt: Date.parse(ticket.created_at) || 0,
      } satisfies Ticket;

      state.tickets[ticket.id] = record;
      state.ticketIdsByColumn[ticket.column_id] = state.ticketIdsByColumn[ticket.column_id] || [];
      state.ticketIdsByColumn[ticket.column_id].push(ticket.id);
    }

    return {
      id: board.id,
      name: board.name,
      description: board.description ?? "",
      data: state,
    } as BoardHydration;
  });
}

export async function getDashboardStats(): Promise<{
  boards: number;
  tickets: number;
  logs: number;
  agendaEvents: number;
  processes: number;
}> {
  const sql = getSql();
  const [boardsRow, ticketsRow, logsRow, agendaRow, processRow] = await Promise.all([
    sql`SELECT COUNT(*)::int as count FROM boards`,
    sql`SELECT COUNT(*)::int as count FROM tickets`,
    sql`SELECT COUNT(*)::int as count FROM agent_logs`,
    sql`SELECT COUNT(*)::int as count FROM agenda_events`,
    sql`SELECT COUNT(*)::int as count FROM process_versions`,
  ]);
  return {
    boards: (boardsRow[0]?.count as number) ?? 0,
    tickets: (ticketsRow[0]?.count as number) ?? 0,
    logs: (logsRow[0]?.count as number) ?? 0,
    agendaEvents: (agendaRow[0]?.count as number) ?? 0,
    processes: (processRow[0]?.count as number) ?? 0,
  };
}

export type OverviewPoint = { date: string; created: number; completed: number };
export type DashboardTask = {
  id: string;
  title: string;
  status: string;
  colorKey: string;
  priority: string;
  dueDate: string | null;
  done: boolean;
  boardId: string;
  boardName: string;
};
export type DashboardOverview = {
  chart: OverviewPoint[];
  totals: { tickets: number; openTickets: number; agendaEvents: number };
  tasks: DashboardTask[];
};

export async function getDashboardOverview(userEmail: string | null): Promise<DashboardOverview> {
  const sql = getSql();
  const workspace = await sql`select id from workspaces order by created_at asc limit 1`;
  const wid = workspace[0]?.id ?? null;
  if (!wid) {
    return { chart: [], totals: { tickets: 0, openTickets: 0, agendaEvents: 0 }, tasks: [] };
  }

  // A ticket belongs to the signed-in user when one of its assignees
  // (board_assignees row, referenced by id in assignee_ids) matches their email.
  const email = userEmail?.trim() || null;

  const [chart, ticketsRow, agendaRow, openRow, taskRows] = await Promise.all([
    getOverviewChart(wid),
    sql`select count(*)::int as count from tickets where workspace_id = ${wid}`,
    sql`select count(*)::int as count from agenda_events where workspace_id = ${wid}`,
    email
      ? sql`
          select count(*)::int as count
          from tickets t
          where t.workspace_id = ${wid}
            and t.execution_state <> 'done'
            and exists (
              select 1 from board_assignees ba
              where ba.id::text = any(t.assignee_ids)
                and lower(ba.email) = lower(${email})
            )
        `
      : Promise.resolve([{ count: 0 }]),
    // Open tickets assigned to the signed-in user, soonest due first.
    email
      ? sql<{
          id: string; title: string; priority: string; due_date: string | null;
          execution_state: string; status: string; color_key: string;
          board_id: string; board_name: string;
        }[]>`
          select t.id, t.title, t.priority, t.due_date::text as due_date, t.execution_state,
                 c.title as status, c.color_key as color_key,
                 b.id as board_id, b.name as board_name
          from tickets t
          join columns c on c.id = t.column_id
          join boards b on b.id = t.board_id
          where t.workspace_id = ${wid}
            and t.execution_state <> 'done'
            and exists (
              select 1 from board_assignees ba
              where ba.id::text = any(t.assignee_ids)
                and lower(ba.email) = lower(${email})
            )
          order by (t.due_date is null) asc, t.due_date asc, t.created_at desc
          limit 8
        `
      : Promise.resolve([]),
  ]);

  const tasks: DashboardTask[] = taskRows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    colorKey: r.color_key ?? "slate",
    priority: r.priority ?? "low",
    dueDate: r.due_date,
    done: r.execution_state === "done",
    boardId: r.board_id,
    boardName: r.board_name,
  }));

  return {
    chart,
    totals: {
      tickets: (ticketsRow[0]?.count as number) ?? 0,
      openTickets: (openRow[0]?.count as number) ?? 0,
      agendaEvents: (agendaRow[0]?.count as number) ?? 0,
    },
    tasks,
  };
}

// Last 90 days of ticket activity (created vs completed) for the overview line chart.
async function getOverviewChart(wid: string): Promise<OverviewPoint[]> {
  const sql = getSql();
  const [createdRows, completedRows] = await Promise.all([
    sql<{ day: string; n: number }[]>`
      select date_trunc('day', created_at)::date::text as day, count(*)::int as n
      from tickets
      where workspace_id = ${wid} and created_at >= now() - interval '90 days'
      group by 1 order by 1
    `,
    sql<{ day: string; n: number }[]>`
      select date_trunc('day', updated_at)::date::text as day, count(*)::int as n
      from tickets
      where workspace_id = ${wid} and execution_state = 'done'
        and updated_at >= now() - interval '90 days'
      group by 1 order by 1
    `,
  ]);

  const createdMap = new Map<string, number>();
  for (const r of createdRows) createdMap.set(r.day, r.n);
  const completedMap = new Map<string, number>();
  for (const r of completedRows) completedMap.set(r.day, r.n);

  const points: OverviewPoint[] = [];
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let offset = 89; offset >= 0; offset--) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() - offset);
    const dateStr = d.toISOString().slice(0, 10);
    points.push({
      date: dateStr,
      created: createdMap.get(dateStr) ?? 0,
      completed: completedMap.get(dateStr) ?? 0,
    });
  }
  return points;
}

