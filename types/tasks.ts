export type ViewMode = "kanban" | "list" | "grid";
export type SortMode = "newest" | "oldest" | "dueDate" | "title";
export type ModalKind = "create" | "details" | "discard" | null;

export type Assignee = {
  id: string;
  name: string;
  initials: string;
  color: string;
  email?: string | null;
  source?: "static" | "runtime";
};

export type TicketPriority = "low" | "medium" | "high" | "urgent";

export type TicketExecutionState =
  | "open"
  | "planning"
  | "awaiting_approval"
  | "ready_to_execute"
  | "executing"
  | "done"
  | "failed"
  | "pending"
  | "queued"
  | "picked_up"
  | "running"
  | "draft"
  | "needs_retry"
  | "expired";

export type TicketExecutionMode = "direct" | "planned";

export type TaskType = "one_time" | "repeatable";
export type Frequency = "daily" | "weekly";

export type Ticket = {
  id: string;
  title: string;
  description: string;
  statusId: string;
  priority: TicketPriority;
  dueDate: string | null;
  tags: string[];
  assigneeIds: string[];
  assignedAgentId?: string;
  executionMode?: TicketExecutionMode;
  planText?: string;
  planApproved?: boolean;
  scheduledFor?: string | null;
  executionState?: TicketExecutionState;
  taskType?: TaskType;
  frequency?: Frequency;
  weekdays?: string[];
  startTime?: string;
  startDateMode?: string;
  endDateMode?: string;
  endDate?: string | null;
  modelOverride?: string;
  checklistDone: number;
  checklistTotal: number;
  comments: number;
  attachments: number;
  createdAt: number;
};

export type TicketAttachment = {
  id: string;
  ticketId: string;
  name: string;
  url: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
};

export type TicketSubtask = {
  id: string;
  ticketId: string;
  title: string;
  completed: boolean;
  position: number;
  checklistName: string;
  createdAt: string;
  updatedAt: string;
};

export type TicketComment = {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorName: string;
  content: string;
  createdAt: string;
};

export type TicketActivity = {
  id: string;
  ticketId: string;
  source: string;
  event: string;
  details: string;
  level: "info" | "success" | "warning" | "error";
  actorName: string | null;
  actorEmail: string | null;
  occurredAt: string;
};

export type Column = {
  id: string;
  title: string;
  tone: "warning" | "info" | "success" | "neutral";
  isDefault: boolean;
};

export type BoardState = {
  columns: Record<string, Column>;
  columnOrder: string[];
  tickets: Record<string, Ticket>;
  ticketIdsByColumn: Record<string, string[]>;
};

export type BoardSummary = {
  id: string;
  name: string;
  description: string;
  totalTickets: number;
  createdAt?: number;
  updatedAt?: number;
  lastTicketAt?: number;
  listCount: number;
};

export type BoardHydration = {
  id: string;
  name: string;
  description: string;
  createdAt?: number;
  updatedAt?: number;
  data: BoardState;
};

export type CreateTicketForm = {
  title: string;
  description: string;
  statusId: string;
  priority: TicketPriority;
  dueDate: string;
  scheduledFor: string;
  tagsText: string;
  assigneeIds: string[];
};

export type TicketDetailsForm = {
  id: string;
  title: string;
  description: string;
  statusId: string;
  priority: TicketPriority;
  dueDate: string;
  scheduledFor: string;
  tagsText: string;
  assigneeIds: string[];
  checklistDone: number;
  checklistTotal: number;
  comments: number;
  attachments: number;
};

export const ASSIGNEES: Assignee[] = [
  { id: "4e2c7ac2-8d2f-4d4f-a8a8-2a3f84d8f8d1", name: "Maya Diaz", initials: "MD", color: "#5B7CF6" },
  { id: "77b37fa2-4d3f-4c3e-bf83-6b4b9e327b77", name: "Isaac Kim", initials: "IK", color: "#55A07A" },
  { id: "0f9f5ce8-7f37-49cd-8f0f-d11a2ef44546", name: "Luna Park", initials: "LP", color: "#F0A64F" },
  { id: "9f4a90fd-2608-4ccd-a625-6fa9a8aa6f28", name: "Zane Cole", initials: "ZC", color: "#EA6C73" },
  { id: "c7b2a6c9-3e73-4d93-a6f0-1b9df8c8a3ab", name: "Nora Lane", initials: "NL", color: "#8A7FF6" },
];

export const VIEW_OPTIONS: Array<{ key: ViewMode; label: string }> = [
  { key: "kanban", label: "Kanban" },
  { key: "list", label: "List" },
  { key: "grid", label: "Grid" },
];

export const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "dueDate", label: "Due date" },
  { key: "title", label: "Title" },
];

export const TICKET_PRIORITY_OPTIONS: Array<{ key: TicketPriority; label: string }> = [
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
  { key: "urgent", label: "Urgent" },
];

export const initialBoard: BoardState = {
  columns: {
    backlog: { id: "backlog", title: "Backlog", tone: "neutral", isDefault: true },
    in_progress: { id: "in_progress", title: "In Progress", tone: "info", isDefault: true },
    review: { id: "review", title: "Review", tone: "warning", isDefault: true },
    done: { id: "done", title: "Done", tone: "success", isDefault: true },
  },
  columnOrder: ["backlog", "in_progress", "review", "done"],
  tickets: {
    "ticket-101": {
      id: "ticket-101",
      title: "Refine tasks analytics card layout",
      description: "Align the summary cards with latest spacing and copy.",
      statusId: "backlog",
      priority: "medium",
      dueDate: "2026-03-12",
      tags: ["Design", "UX"],
      assigneeIds: ["4e2c7ac2-8d2f-4d4f-a8a8-2a3f84d8f8d1", "77b37fa2-4d3f-4c3e-bf83-6b4b9e327b77"],
      checklistDone: 2,
      checklistTotal: 5,
      comments: 4,
      attachments: 1,
      createdAt: 1709200001000,
    },
    "ticket-102": {
      id: "ticket-102",
      title: "Prepare Q2 planning checklist template",
      description: "Create reusable structure for roadmap planning sessions.",
      statusId: "backlog",
      priority: "low",
      dueDate: "2026-03-14",
      tags: ["Planning"],
      assigneeIds: ["c7b2a6c9-3e73-4d93-a6f0-1b9df8c8a3ab"],
      checklistDone: 1,
      checklistTotal: 3,
      comments: 1,
      attachments: 0,
      createdAt: 1709200002000,
    },
    "ticket-103": {
      id: "ticket-103",
      title: "Implement sidebar compact mode interactions",
      description: "Add smooth collapse behavior and icon-only labels.",
      statusId: "in_progress",
      priority: "high",
      dueDate: "2026-03-08",
      tags: ["Frontend"],
      assigneeIds: ["9f4a90fd-2608-4ccd-a625-6fa9a8aa6f28", "4e2c7ac2-8d2f-4d4f-a8a8-2a3f84d8f8d1"],
      checklistDone: 3,
      checklistTotal: 6,
      comments: 7,
      attachments: 2,
      createdAt: 1709200003000,
    },
    "ticket-104": {
      id: "ticket-104",
      title: "Hook list filters to shared task query state",
      description: "Keep search and sort behavior consistent across views.",
      statusId: "in_progress",
      priority: "medium",
      dueDate: "2026-03-10",
      tags: ["Data", "Frontend"],
      assigneeIds: ["77b37fa2-4d3f-4c3e-bf83-6b4b9e327b77"],
      checklistDone: 4,
      checklistTotal: 5,
      comments: 2,
      attachments: 3,
      createdAt: 1709200004000,
    },
    "ticket-105": {
      id: "ticket-105",
      title: "QA drag-and-drop placeholder behavior",
      description: "Validate insertion markers across desktop and tablet.",
      statusId: "review",
      priority: "high",
      dueDate: "2026-03-06",
      tags: ["QA"],
      assigneeIds: ["0f9f5ce8-7f37-49cd-8f0f-d11a2ef44546", "9f4a90fd-2608-4ccd-a625-6fa9a8aa6f28"],
      checklistDone: 5,
      checklistTotal: 6,
      comments: 3,
      attachments: 1,
      createdAt: 1709200005000,
    },
    "ticket-106": {
      id: "ticket-106",
      title: "Write release note snippets for tasks module",
      description: "Draft concise update bullets for the sprint changelog.",
      statusId: "done",
      priority: "low",
      dueDate: "2026-03-02",
      tags: ["Docs"],
      assigneeIds: ["c7b2a6c9-3e73-4d93-a6f0-1b9df8c8a3ab", "4e2c7ac2-8d2f-4d4f-a8a8-2a3f84d8f8d1"],
      checklistDone: 4,
      checklistTotal: 4,
      comments: 0,
      attachments: 0,
      createdAt: 1709200006000,
    },
  },
  ticketIdsByColumn: {
    backlog: ["ticket-101", "ticket-102"],
    in_progress: ["ticket-103", "ticket-104"],
    review: ["ticket-105"],
    done: ["ticket-106"],
  },
};

export const emptyCreateForm = (statusId: string): CreateTicketForm => ({
  title: "",
  description: "",
  statusId,
  priority: "low",
  dueDate: "",
  scheduledFor: "",
  tagsText: "",
  assigneeIds: [],
});

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export const formatDue = (dueDate: string | null): string => {
  if (!dueDate) return "No due";

  const parts = dueDate.split("-");
  if (parts.length !== 3) return "No due";

  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(month) || !Number.isInteger(day)) return "No due";
  if (month < 1 || month > 12 || day < 1 || day > 31) return "No due";

  return `${MONTH_SHORT[month - 1]} ${day}`;
};

export const toneColor: Record<Column["tone"], string> = {
  neutral: "bg-slate-400",
  info: "bg-blue-500",
  warning: "bg-amber-500",
  success: "bg-emerald-500",
};
