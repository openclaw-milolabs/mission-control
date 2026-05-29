"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { getDataAdapter } from "@/lib/db";
import type {
  ColumnRecord,
  CreateTicketPayload,
  TicketActivityRecord,
  TicketCommentRecord,
  TicketAttachmentRecord,
  TicketRecord,
  TicketSubtaskRecord,
} from "@/lib/db/adapter";
import {
  type Assignee,
  type BoardHydration,
  type BoardSummary,
  type TicketActivity,
  type TicketComment,
  type BoardState,
  type Column,
  type CreateTicketForm,
  type ModalKind,
  type SortMode,
  type TicketAttachment,
  type TicketPriority,
  type TicketSubtask,
  type Ticket,
  type TicketDetailsForm,
  type ViewMode,
  emptyCreateForm,
} from "@/types/tasks";

type BoardEntry = {
  id: string;
  name: string;
  description: string;
  createdAt?: number;
  updatedAt?: number;
  data: BoardState;
};

type RawBoard = {
  id: string;
  name: string;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_ticket_at?: string | null;
};

type RawColumn = {
  id: string;
  board_id: string;
  title: string;
  color_key: string | null;
  is_default: boolean | null;
};

type RawTicket = {
  id: string;
  board_id: string;
  column_id: string;
  title: string;
  description: string | null;
  priority: string;
  due_date: string | null;
  tags: string[] | null;
  assignee_ids: string[] | null;
  scheduled_for: string | null;
  checklist_done: number | null;
  checklist_total: number | null;
  comments_count: number | null;
  attachments_count: number | null;
  created_at: string;
};

type UseTasksOptions = {
  initialBoardId: string | null;
  initialBoards: BoardHydration[];
  assigneesByBoardId: Record<string, Assignee[]>;
};

const sameText = (a: string, b: string) => a.trim() === b.trim();


const cloneBoard = (board: BoardState): BoardState => ({
  columns: Object.fromEntries(
    Object.entries(board.columns).map(([id, column]) => [id, { ...column }]),
  ),
  columnOrder: [...board.columnOrder],
  tickets: Object.fromEntries(
    Object.entries(board.tickets).map(([id, ticket]) => [
      id,
      {
        ...ticket,
        tags: [...ticket.tags],
        assigneeIds: [...ticket.assigneeIds],
      },
    ]),
  ),
  ticketIdsByColumn: Object.fromEntries(
    Object.entries(board.ticketIdsByColumn).map(([id, ticketIds]) => [id, [...ticketIds]]),
  ),
});

const cloneBoardEntry = (entry: BoardHydration): BoardEntry => ({
  id: entry.id,
  name: entry.name,
  description: entry.description,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  data: cloneBoard(entry.data),
});

const createEmptyBoard = (): BoardState => ({
  columns: {},
  columnOrder: [],
  tickets: {},
  ticketIdsByColumn: {},
});

const toneFromColorKey = (colorKey: string | null): Column["tone"] => {
  if (colorKey === "success" || colorKey === "emerald") return "success";
  if (colorKey === "warning" || colorKey === "amber") return "warning";
  if (colorKey === "info" || colorKey === "blue") return "info";
  return "neutral";
};

const colorKeyFromTone = (tone: Column["tone"]): string | null => {
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "info") return "info";
  return null;
};

function hydrateBoards(
  rawBoards: RawBoard[],
  rawColumns: RawColumn[],
  rawTickets: RawTicket[]
): BoardHydration[] {
  const columnsByBoard = rawColumns.reduce<Record<string, RawColumn[]>>((acc, col) => {
    (acc[col.board_id] ??= []).push(col);
    return acc;
  }, {});
  const ticketsByBoard = rawTickets.reduce<Record<string, RawTicket[]>>((acc, t) => {
    (acc[t.board_id] ??= []).push(t);
    return acc;
  }, {});

  const pad = (n: number) => String(n).padStart(2, "0");

  const formatDateUTC = (dateStr: string | null) => {
    if (!dateStr) return "—";
    try {
      const d = new Date(dateStr);
      const year = d.getUTCFullYear();
      const month = pad(d.getUTCMonth() + 1);
      const day = pad(d.getUTCDate());
      return `${month}/${day}/${year}`;
    } catch {
      return "—";
    }
  };

  const formatDateTimeUTC = (dateStr: string | null) => {
    if (!dateStr) return "No tasks yet";
    try {
      const d = new Date(dateStr);
      const year = d.getUTCFullYear();
      const month = pad(d.getUTCMonth() + 1);
      const day = pad(d.getUTCDate());
      const hours = pad(d.getUTCHours());
      const minutes = pad(d.getUTCMinutes());
      return `${month}/${day}/${year}, ${hours}:${minutes} UTC`;
    } catch {
      return "—";
    }
  };

  return rawBoards.map((board) => {
    const boardCols = columnsByBoard[board.id] ?? [];
    const boardTix = ticketsByBoard[board.id] ?? [];

    const state: BoardState = createEmptyBoard();

    for (const col of boardCols) {
      state.columns[col.id] = {
        id: col.id,
        title: col.title,
        tone: toneFromColorKey(col.color_key),
        isDefault: Boolean(col.is_default),
      } as Column;
      state.columnOrder.push(col.id);
      state.ticketIdsByColumn[col.id] = [];
    }

    for (const t of boardTix) {
      const ticket: Ticket = {
        id: t.id,
        title: t.title,
        description: t.description ?? "",
        statusId: t.column_id,
        priority: isTicketPriority(t.priority) ? t.priority : "medium",
        dueDate: t.due_date,
        tags: t.tags ?? [],
        assigneeIds: t.assignee_ids ?? [],
        scheduledFor: t.scheduled_for ? t.scheduled_for.slice(0, 10) : null,
        checklistDone: t.checklist_done ?? 0,
        checklistTotal: t.checklist_total ?? 0,
        comments: t.comments_count ?? 0,
        attachments: t.attachments_count ?? 0,
        createdAt: Date.parse(t.created_at) || 0,
      };
      state.tickets[t.id] = ticket;
      state.ticketIdsByColumn[t.column_id] = state.ticketIdsByColumn[t.column_id] || [];
      state.ticketIdsByColumn[t.column_id].push(t.id);
    }

    return {
      id: board.id,
      name: board.name,
      description: board.description ?? "",
      data: state,
      created_at_formatted: formatDateUTC(board.created_at),
      updated_at_formatted: formatDateUTC(board.updated_at),
      last_ticket_at_formatted: formatDateTimeUTC(board.last_ticket_at ?? null),
    } as BoardHydration;
  });
}

const DEFAULT_LOCKED_LIST_TITLES = new Set(["to-do", "todo", "in progress", "completed", "planned", "doing"]);
const isTicketPriority = (value: string): value is TicketPriority =>
  value === "low" || value === "medium" || value === "high" || value === "urgent";

const formatDueDateInput = (value: string | null) => (value ? value.slice(0, 10) : null);
const toIsoDueDate = (value: string) => {
  if (!value) return null;
  if (value.includes('T')) return value; // already an ISO datetime
  return `${value}T00:00:00.000Z`;
};
const toDueDateLabel = (value: string) => {
  if (!value) return "No due date";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const toTicket = (row: TicketRecord): Ticket => ({
  id: row.id,
  title: row.title,
  description: row.description,
  statusId: row.columnId,
  priority: isTicketPriority(row.priority) ? row.priority : "low",
  dueDate: formatDueDateInput(row.dueDate),
  tags: row.tags,
  assigneeIds: row.assigneeIds,
  scheduledFor: formatDueDateInput(row.scheduledFor),
  checklistDone: row.checklistDone,
  checklistTotal: row.checklistTotal,
  comments: row.commentsCount,
  attachments: row.attachmentsCount,
  createdAt: new Date(row.createdAt).valueOf(),
});

const toTicketAttachment = (row: TicketAttachmentRecord): TicketAttachment => ({
  id: row.id,
  ticketId: row.ticketId,
  name: row.name,
  url: row.url,
  mimeType: row.mimeType,
  size: row.size,
  path: row.path,
  createdAt: row.createdAt,
});

const toTicketSubtask = (row: TicketSubtaskRecord): TicketSubtask => ({
  id: row.id,
  ticketId: row.ticketId,
  title: row.title,
  completed: row.completed,
  position: row.position,
  checklistName: row.checklistName,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toTicketComment = (row: TicketCommentRecord): TicketComment => ({
  id: row.id,
  ticketId: row.ticketId,
  authorId: row.authorId,
  authorName: row.authorName,
  content: row.content,
  createdAt: row.createdAt,
});

const toTicketActivity = (row: TicketActivityRecord): TicketActivity => ({
  id: row.id,
  ticketId: row.ticketId,
  source: row.source,
  event: row.event,
  details: row.details,
  level: row.level,
  actorName: row.actorName ?? null,
  actorEmail: row.actorEmail ?? null,
  occurredAt: row.occurredAt,
});

const defaultBoardColumns: Array<{ title: string; colorKey: string; isDefault: boolean }> = [
  { title: "To-Do", colorKey: "neutral", isDefault: true },
  { title: "In progress", colorKey: "info", isDefault: true },
  { title: "Completed", colorKey: "success", isDefault: true },
];

const buildBoardState = (columnRows: ColumnRecord[], ticketRows: TicketRecord[]): BoardState => {
  const columns: BoardState["columns"] = {};
  const columnOrder: string[] = [];
  const ticketIdsByColumn: Record<string, string[]> = {};

  for (const row of [...columnRows].sort((a, b) => a.position - b.position)) {
    columns[row.id] = {
      id: row.id,
      title: row.title,
      tone: toneFromColorKey(row.colorKey),
      isDefault: row.isDefault,
    };
    columnOrder.push(row.id);
    ticketIdsByColumn[row.id] = [];
  }

  const tickets: BoardState["tickets"] = {};
  const columnIndexById = Object.fromEntries(columnOrder.map((id, index) => [id, index]));
  const sortedTickets = [...ticketRows].sort((a, b) => {
    const aIndex = columnIndexById[a.columnId] ?? Number.MAX_SAFE_INTEGER;
    const bIndex = columnIndexById[b.columnId] ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.position - b.position;
  });

  for (const row of sortedTickets) {
    if (!columns[row.columnId]) continue;
    const ticket = toTicket(row);
    tickets[ticket.id] = ticket;
    ticketIdsByColumn[row.columnId].push(ticket.id);
  }

  return {
    columns,
    columnOrder,
    tickets,
    ticketIdsByColumn,
  };
};

export function useTasks({ initialBoardId, initialBoards, assigneesByBoardId }: UseTasksOptions) {
  const adapter = useMemo(() => getDataAdapter(), []);
  const [boardMap, setBoardMap] = useState<Record<string, BoardEntry>>(() =>
    Object.fromEntries(initialBoards.map((board) => [board.id, cloneBoardEntry(board)])),
  );
  const [boardOrder, setBoardOrder] = useState<string[]>(() =>
    initialBoards.map((board) => board.id),
  );
  const [activeBoardId, setActiveBoardId] = useState(() => {
    if (initialBoardId && initialBoards.some((board) => board.id === initialBoardId)) {
      return initialBoardId;
    }
    return initialBoards[0]?.id ?? "";
  });

  const [view, setView] = useState<ViewMode>("kanban");
  const [sort, setSort] = useState<SortMode>("newest");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  // Assignee filter: empty Set = no filter (show all). Sentinel "__unassigned__"
  // matches tickets with empty assignee_ids.
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(() => new Set<string>());
  // Per-column pagination cap: render up to LIST_PAGE_SIZE tickets per column by default;
  // user can expand a column to see the rest. Prevents 130-ticket walls of cards.
  const [expandedColumnIds, setExpandedColumnIds] = useState<Set<string>>(() => new Set<string>());
  const [modal, setModal] = useState<ModalKind>(null);
  const [discardTarget, setDiscardTarget] = useState<"create" | "details" | null>(null);
  const [createForm, setCreateForm] = useState<CreateTicketForm>(() => emptyCreateForm(""));
  const [createSnapshot, setCreateSnapshot] = useState<CreateTicketForm>(() =>
    emptyCreateForm(""),
  );
  const [detailsForm, setDetailsForm] = useState<TicketDetailsForm | null>(null);
  const [detailsSnapshot, setDetailsSnapshot] = useState<TicketDetailsForm | null>(null);
  const [attachmentsByTicketId, setAttachmentsByTicketId] = useState<Record<string, TicketAttachment[]>>({});
  const [loadingAttachmentsTicketId, setLoadingAttachmentsTicketId] = useState<string | null>(null);
  const [uploadingAttachmentsTicketId, setUploadingAttachmentsTicketId] = useState<string | null>(null);
  const [subtasksByTicketId, setSubtasksByTicketId] = useState<Record<string, TicketSubtask[]>>({});
  const [loadingSubtasksTicketId, setLoadingSubtasksTicketId] = useState<string | null>(null);
  const [commentsByTicketId, setCommentsByTicketId] = useState<Record<string, TicketComment[]>>({});
  const [loadingCommentsTicketId, setLoadingCommentsTicketId] = useState<string | null>(null);
  const [activityByTicketId, setActivityByTicketId] = useState<Record<string, TicketActivity[]>>({});
  const [loadingActivityTicketId, setLoadingActivityTicketId] = useState<string | null>(null);
  const [subtaskDraftsByChecklist, setSubtaskDraftsByChecklist] = useState<Record<string, string>>({});
  const setSubtaskDraftForChecklist = useCallback((checklistName: string, value: string) => {
    setSubtaskDraftsByChecklist((prev) => ({ ...prev, [checklistName]: value }));
  }, []);
  const [commentDraft, setCommentDraft] = useState("");
  const [createError, setCreateError] = useState("");

  const [createBoardOpen, setCreateBoardOpen] = useState(false);
  const [createBoardTitle, setCreateBoardTitle] = useState("");
  const [createBoardDescription, setCreateBoardDescription] = useState("");
  const [createBoardError, setCreateBoardError] = useState("");

  const [editBoardOpen, setEditBoardOpen] = useState(false);
  const [editBoardId, setEditBoardId] = useState("");
  const [editBoardTitle, setEditBoardTitle] = useState("");
  const [editBoardDescription, setEditBoardDescription] = useState("");
  const [editBoardError, setEditBoardError] = useState("");

  const [createListOpen, setCreateListOpen] = useState(false);
  const [createListTitle, setCreateListTitle] = useState("");
  const [createListError, setCreateListError] = useState("");

  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const activeBoardRef = useRef<BoardState>(createEmptyBoard());

  const fallbackBoard = useMemo<BoardEntry>(
    () => ({
      id: "",
      name: "",
      description: "",
      data: createEmptyBoard(),
    }),
    [],
  );

  const activeBoard = boardMap[activeBoardId] ?? fallbackBoard;
  const board = activeBoard.data;
  const activeBoardName = activeBoard.name;
  const activeBoardDescription = activeBoard.description;

  useEffect(() => {
    activeBoardRef.current = board;
  }, [board]);

  const boards = useMemo(
    () =>
      boardOrder
        .map((id) => boardMap[id])
        .filter(Boolean)
        .map((entry) => ({ id: entry.id, name: entry.name })),
    [boardMap, boardOrder],
  );

  const boardSummaries = useMemo(
    () =>
      boardOrder
        .map((id) => boardMap[id])
        .filter(Boolean)
        .map((entry): BoardSummary => {
          const tickets = Object.values(entry.data.tickets).sort((a, b) => b.createdAt - a.createdAt);
          return {
            id: entry.id,
            name: entry.name,
            description: entry.description,
            totalTickets: tickets.length,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            lastTicketAt: tickets[0]?.createdAt,
            listCount: entry.data.columnOrder.length,
          };
        }),
    [boardMap, boardOrder],
  );

  const updateActiveBoard = (updater: (prev: BoardState) => BoardState) => {
    setBoardMap((prev) => {
      const entry = prev[activeBoardId];
      if (!entry) return prev;
      const nextData = updater(entry.data);
      if (nextData === entry.data) return prev;
      return {
        ...prev,
        [activeBoardId]: {
          ...entry,
          data: nextData,
        },
      };
    });
  };

  const selectBoard = (nextBoardId: string) => {
    if (!boardMap[nextBoardId] || nextBoardId === activeBoardId) return;
    setActiveBoardId(nextBoardId);
    setModal(null);
    setDiscardTarget(null);
    setDetailsForm(null);
    setDetailsSnapshot(null);
    setCreateError("");
    setCreateListError("");
    setCreateBoardError("");
    setEditBoardError("");
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(searchInput.trim().toLowerCase());
    }, 150);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const assignees = useMemo(
    () => assigneesByBoardId[activeBoardId] ?? [],
    [assigneesByBoardId, activeBoardId],
  );
  const assigneeById = useMemo(
    () => Object.fromEntries(assignees.map((a) => [a.id, a])),
    [assignees],
  );
  const validAssigneeIds = (ids: string[]) => ids.filter((id) => Boolean(assigneeById[id]));
  const resolveAssigneeName = useCallback((id: string) => assigneeById[id]?.name ?? id, [assigneeById]);

  const ticketsList = useMemo(() => Object.values(board.tickets), [board.tickets]);

  const filteredTicketIds = useMemo(() => {
    const hasSearch = Boolean(searchQuery);
    const hasAssigneeFilter = assigneeFilter.size > 0;
    if (!hasSearch && !hasAssigneeFilter) {
      return new Set<string>(ticketsList.map((ticket) => ticket.id));
    }
    return new Set<string>(
      ticketsList
        .filter((ticket) => {
          if (hasAssigneeFilter) {
            const wantsUnassigned = assigneeFilter.has("__unassigned__");
            const hasAny = ticket.assigneeIds.length > 0;
            const matchesNamed = ticket.assigneeIds.some((id) => assigneeFilter.has(id));
            const matchesUnassigned = wantsUnassigned && !hasAny;
            if (!matchesNamed && !matchesUnassigned) return false;
          }
          if (hasSearch) {
            const names = ticket.assigneeIds
              .map((id) => resolveAssigneeName(id))
              .join(" ");
            const haystack = [ticket.title, ticket.description, ticket.tags.join(" "), names]
              .join(" ")
              .toLowerCase();
            if (!haystack.includes(searchQuery)) return false;
          }
          return true;
        })
        .map((ticket) => ticket.id),
    );
  }, [assigneeFilter, resolveAssigneeName, searchQuery, ticketsList]);

  const toggleAssigneeFilter = useCallback((assigneeId: string) => {
    setAssigneeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(assigneeId)) next.delete(assigneeId);
      else next.add(assigneeId);
      return next;
    });
  }, []);
  const clearAssigneeFilter = useCallback(() => setAssigneeFilter(new Set<string>()), []);

  const sortedFilteredTickets = useMemo(() => {
    return ticketsList
      .filter((ticket) => filteredTicketIds.has(ticket.id))
      .sort((a, b) => {
        if (sort === "title") return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        if (sort === "dueDate") {
          const aDue = a.dueDate ? new Date(`${a.dueDate}T00:00:00`).valueOf() : Number.MAX_SAFE_INTEGER;
          const bDue = b.dueDate ? new Date(`${b.dueDate}T00:00:00`).valueOf() : Number.MAX_SAFE_INTEGER;
          return aDue !== bDue ? aDue - bDue : b.createdAt - a.createdAt;
        }
        if (sort === "oldest") return a.createdAt - b.createdAt;
        return b.createdAt - a.createdAt;
      });
  }, [filteredTicketIds, sort, ticketsList]);

  const visibleTicketIdsByColumn = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const columnId of board.columnOrder) {
      result[columnId] = (board.ticketIdsByColumn[columnId] ?? []).filter((id) =>
        filteredTicketIds.has(id),
      );
    }
    return result;
  }, [board.columnOrder, board.ticketIdsByColumn, filteredTicketIds]);

  const LIST_PAGE_SIZE = 25;
  // After filtering, cap rendering per column unless the user expanded it.
  // `hiddenCountByColumn` is what the UI needs to render "Show more (N hidden)".
  const renderedTicketIdsByColumn = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const columnId of board.columnOrder) {
      const full = visibleTicketIdsByColumn[columnId] ?? [];
      result[columnId] = expandedColumnIds.has(columnId) ? full : full.slice(0, LIST_PAGE_SIZE);
    }
    return result;
  }, [board.columnOrder, expandedColumnIds, visibleTicketIdsByColumn]);

  const hiddenCountByColumn = useMemo(() => {
    const result: Record<string, number> = {};
    for (const columnId of board.columnOrder) {
      const total = (visibleTicketIdsByColumn[columnId] ?? []).length;
      const rendered = (renderedTicketIdsByColumn[columnId] ?? []).length;
      result[columnId] = Math.max(0, total - rendered);
    }
    return result;
  }, [board.columnOrder, visibleTicketIdsByColumn, renderedTicketIdsByColumn]);

  const expandColumn = useCallback((columnId: string) => {
    setExpandedColumnIds((prev) => {
      const next = new Set(prev);
      next.add(columnId);
      return next;
    });
  }, []);
  const collapseColumn = useCallback((columnId: string) => {
    setExpandedColumnIds((prev) => {
      const next = new Set(prev);
      next.delete(columnId);
      return next;
    });
  }, []);

  const createDirty = useMemo(
    () =>
      !sameText(createForm.title, createSnapshot.title) ||
      !sameText(createForm.description, createSnapshot.description) ||
      createForm.statusId !== createSnapshot.statusId ||
      createForm.priority !== createSnapshot.priority ||
      createForm.dueDate !== createSnapshot.dueDate ||
      createForm.scheduledFor !== createSnapshot.scheduledFor ||
      !sameText(createForm.tagsText, createSnapshot.tagsText) ||
      createForm.assigneeIds.join(",") !== createSnapshot.assigneeIds.join(","),
    [createForm, createSnapshot],
  );

  const detailsDirty = useMemo(() => {
    if (!detailsForm || !detailsSnapshot) return false;
    return (
      !sameText(detailsForm.title, detailsSnapshot.title) ||
      !sameText(detailsForm.description, detailsSnapshot.description) ||
      detailsForm.statusId !== detailsSnapshot.statusId ||
      detailsForm.priority !== detailsSnapshot.priority ||
      detailsForm.dueDate !== detailsSnapshot.dueDate ||
      detailsForm.scheduledFor !== detailsSnapshot.scheduledFor ||
      !sameText(detailsForm.tagsText, detailsSnapshot.tagsText) ||
      detailsForm.assigneeIds.join(",") !== detailsSnapshot.assigneeIds.join(",")
    );
  }, [detailsForm, detailsSnapshot]);

  const detailsAttachments = useMemo(
    () => (detailsForm ? attachmentsByTicketId[detailsForm.id] ?? [] : []),
    [attachmentsByTicketId, detailsForm],
  );
  const detailsSubtasks = useMemo(
    () => (detailsForm ? subtasksByTicketId[detailsForm.id] ?? [] : []),
    [detailsForm, subtasksByTicketId],
  );
  const detailsComments = useMemo(
    () => (detailsForm ? commentsByTicketId[detailsForm.id] ?? [] : []),
    [commentsByTicketId, detailsForm],
  );
  const detailsActivity = useMemo(
    () => (detailsForm ? activityByTicketId[detailsForm.id] ?? [] : []),
    [activityByTicketId, detailsForm],
  );
  const detailsAttachmentsLoading =
    Boolean(detailsForm) && loadingAttachmentsTicketId === detailsForm?.id;
  const detailsAttachmentsUploading =
    Boolean(detailsForm) && uploadingAttachmentsTicketId === detailsForm?.id;
  const detailsSubtasksLoading =
    Boolean(detailsForm) && loadingSubtasksTicketId === detailsForm?.id;
  const detailsCommentsLoading =
    Boolean(detailsForm) && loadingCommentsTicketId === detailsForm?.id;
  const detailsActivityLoading =
    Boolean(detailsForm) && loadingActivityTicketId === detailsForm?.id;

  const rememberTrigger = () => {
    if (document.activeElement instanceof HTMLElement) {
      modalTriggerRef.current = document.activeElement;
    }
  };

  const restoreFocus = () => {
    const trigger = modalTriggerRef.current;
    if (trigger) window.requestAnimationFrame(() => trigger.focus());
  };

  const openCreateModal = (statusId: string) => {
    rememberTrigger();
    const fallbackStatusId = board.columnOrder[0] ?? "";
    const resolvedStatusId = board.columns[statusId] ? statusId : fallbackStatusId;
    const form = emptyCreateForm(resolvedStatusId);
    setCreateForm(form);
    setCreateSnapshot(form);
    setCreateError("");
    setModal("create");
  };

  const openDetailsModal = (ticketId: string) => {
    const ticket = board.tickets[ticketId];
    if (!ticket) return;
    rememberTrigger();
    const form: TicketDetailsForm = {
      id: ticket.id,
      title: ticket.title,
      description: ticket.description,
      statusId: ticket.statusId,
      priority: ticket.priority,
      dueDate: ticket.dueDate ?? "",
      scheduledFor: ticket.scheduledFor ?? "",
      tagsText: ticket.tags.join(", "),
      assigneeIds: validAssigneeIds(ticket.assigneeIds),
      checklistDone: ticket.checklistDone,
      checklistTotal: ticket.checklistTotal,
      comments: ticket.comments,
      attachments: ticket.attachments,
    };
    setDetailsForm(form);
    setDetailsSnapshot(form);
    setSubtaskDraftsByChecklist({});
    setCommentDraft("");
    setModal("details");
    void loadTicketAttachments(ticket.id);
    void loadTicketSubtasks(ticket.id);
    void loadTicketComments(ticket.id);
    void loadTicketActivity(ticket.id);
  };

  const setTicketAttachmentCount = (ticketId: string, count: number) => {
    updateActiveBoard((prev) => {
      const ticket = prev.tickets[ticketId];
      if (!ticket || ticket.attachments === count) {
        return prev;
      }
      return {
        ...prev,
        tickets: {
          ...prev.tickets,
          [ticketId]: {
            ...ticket,
            attachments: count,
          },
        },
      };
    });

    setDetailsForm((prev) => {
      if (!prev || prev.id !== ticketId || prev.attachments === count) {
        return prev;
      }
      return {
        ...prev,
        attachments: count,
      };
    });
  };

  const setTicketChecklistCounts = (ticketId: string, done: number, total: number) => {
    updateActiveBoard((prev) => {
      const ticket = prev.tickets[ticketId];
      if (!ticket) {
        return prev;
      }
      if (ticket.checklistDone === done && ticket.checklistTotal === total) {
        return prev;
      }
      return {
        ...prev,
        tickets: {
          ...prev.tickets,
          [ticketId]: {
            ...ticket,
            checklistDone: done,
            checklistTotal: total,
          },
        },
      };
    });

    setDetailsForm((prev) => {
      if (!prev || prev.id !== ticketId) {
        return prev;
      }
      if (prev.checklistDone === done && prev.checklistTotal === total) {
        return prev;
      }
      return {
        ...prev,
        checklistDone: done,
        checklistTotal: total,
      };
    });
  };

  const setTicketCommentCount = (ticketId: string, count: number) => {
    updateActiveBoard((prev) => {
      const ticket = prev.tickets[ticketId];
      if (!ticket || ticket.comments === count) {
        return prev;
      }
      return {
        ...prev,
        tickets: {
          ...prev.tickets,
          [ticketId]: {
            ...ticket,
            comments: count,
          },
        },
      };
    });

    setDetailsForm((prev) => {
      if (!prev || prev.id !== ticketId || prev.comments === count) {
        return prev;
      }
      return {
        ...prev,
        comments: count,
      };
    });
  };

  const loadTicketAttachments = async (ticketId: string) => {
    setLoadingAttachmentsTicketId(ticketId);
    try {
      const rows = await adapter.listTicketAttachments(ticketId);
      const attachments = rows.map(toTicketAttachment);
      setAttachmentsByTicketId((prev) => ({
        ...prev,
        [ticketId]: attachments,
      }));
      setTicketAttachmentCount(ticketId, attachments.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load attachments.";
      toast.error(message);
    } finally {
      setLoadingAttachmentsTicketId((current) => (current === ticketId ? null : current));
    }
  };

  const uploadDetailsAttachments = async (files: FileList | File[] | null) => {
    const ticketId = detailsForm?.id;
    if (!ticketId || !files || files.length === 0) {
      return;
    }

    const fileList = Array.from(files);
    setUploadingAttachmentsTicketId(ticketId);
    try {
      const uploaded: TicketAttachment[] = [];
      for (const file of fileList) {
        const created = await adapter.uploadTicketAttachment(ticketId, file);
        uploaded.push(toTicketAttachment(created));
      }

      let nextCount = 0;
      setAttachmentsByTicketId((prev) => {
        const next = [...(prev[ticketId] ?? []), ...uploaded];
        nextCount = next.length;
        return {
          ...prev,
          [ticketId]: next,
        };
      });
      setTicketAttachmentCount(ticketId, nextCount);

      toast.success(
        uploaded.length === 1 ? "Attachment uploaded" : `${uploaded.length} attachments uploaded`,
      );
      await createTicketActivity(
        ticketId,
        uploaded.length === 1 ? "Attachment added" : "Attachments added",
        uploaded.length === 1
          ? `Added attachment "${uploaded[0]?.name ?? "file"}".`
          : `Added ${uploaded.length} attachments.`,
        "success",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to upload attachment.";
      toast.error(message);
    } finally {
      setUploadingAttachmentsTicketId((current) => (current === ticketId ? null : current));
    }
  };

  const deleteDetailsAttachment = async (attachmentId: string) => {
    const ticketId = detailsForm?.id;
    if (!ticketId || !attachmentId) {
      return;
    }

    const previous = attachmentsByTicketId[ticketId] ?? [];
    const removedAttachment = previous.find((attachment) => attachment.id === attachmentId) ?? null;
    const next = previous.filter((attachment) => attachment.id !== attachmentId);

    setAttachmentsByTicketId((prev) => ({
      ...prev,
      [ticketId]: next,
    }));
    setTicketAttachmentCount(ticketId, next.length);

    try {
      await adapter.deleteTicketAttachment(attachmentId);
      toast.success("Attachment deleted");
      await createTicketActivity(
        ticketId,
        "Attachment removed",
        removedAttachment
          ? `Removed attachment "${removedAttachment.name}".`
          : "Removed an attachment.",
        "warning",
      );
    } catch (error) {
      setAttachmentsByTicketId((prev) => ({
        ...prev,
        [ticketId]: previous,
      }));
      setTicketAttachmentCount(ticketId, previous.length);
      const message = error instanceof Error ? error.message : "Failed to delete attachment.";
      toast.error(message);
    }
  };

  const loadTicketSubtasks = async (ticketId: string) => {
    setLoadingSubtasksTicketId(ticketId);
    try {
      const rows = await adapter.listTicketSubtasks(ticketId);
      const subtasks = rows.map(toTicketSubtask).sort((a, b) => a.position - b.position);
      setSubtasksByTicketId((prev) => ({
        ...prev,
        [ticketId]: subtasks,
      }));

      const checklistTotal = subtasks.length;
      const checklistDone = subtasks.filter((item) => item.completed).length;
      setTicketChecklistCounts(ticketId, checklistDone, checklistTotal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load tasks.";
      toast.error(message);
    } finally {
      setLoadingSubtasksTicketId((current) => (current === ticketId ? null : current));
    }
  };

  const addDetailsSubtask = async (checklistName: string, title?: string) => {
    const ticketId = detailsForm?.id;
    const resolvedTitle = (title ?? subtaskDraftsByChecklist[checklistName] ?? "").trim();
    if (!ticketId || !resolvedTitle) return;

    setSubtaskDraftsByChecklist((prev) => ({ ...prev, [checklistName]: "" }));
    try {
      const created = await adapter.createTicketSubtask(ticketId, { title: resolvedTitle, checklistName });
      setSubtasksByTicketId((prev) => {
        const next = [...(prev[ticketId] ?? []), toTicketSubtask(created)].sort(
          (a, b) => a.position - b.position,
        );
        setTicketChecklistCounts(
          ticketId,
          next.filter((item) => item.completed).length,
          next.length,
        );
        return { ...prev, [ticketId]: next };
      });
      toast.success("Task added");
      await createTicketActivity(ticketId, "Task added", `Added subtask "${resolvedTitle}".`, "success");
    } catch (error) {
      setSubtaskDraftsByChecklist((prev) => ({ ...prev, [checklistName]: resolvedTitle }));
      const message = error instanceof Error ? error.message : "Failed to add task.";
      toast.error(message);
    }
  };

  const toggleDetailsSubtask = async (subtaskId: string, completed: boolean) => {
    const ticketId = detailsForm?.id;
    if (!ticketId) {
      return;
    }

    let previous: TicketSubtask[] = [];
    setSubtasksByTicketId((prev) => {
      previous = [...(prev[ticketId] ?? [])];
      const next = previous.map((item) =>
        item.id === subtaskId ? { ...item, completed } : item,
      );
      setTicketChecklistCounts(
        ticketId,
        next.filter((item) => item.completed).length,
        next.length,
      );
      return {
        ...prev,
        [ticketId]: next,
      };
    });

    try {
      await adapter.updateTicketSubtask(subtaskId, { completed });
      const subtaskTitle = previous.find((item) => item.id === subtaskId)?.title ?? "Subtask";
      await createTicketActivity(
        ticketId,
        completed ? "Task completed" : "Task reopened",
        completed
          ? `Marked "${subtaskTitle}" as complete.`
          : `Marked "${subtaskTitle}" as not complete.`,
        completed ? "success" : "info",
      );
    } catch (error) {
      setSubtasksByTicketId((prev) => ({
        ...prev,
        [ticketId]: previous,
      }));
      setTicketChecklistCounts(
        ticketId,
        previous.filter((item) => item.completed).length,
        previous.length,
      );
      const message = error instanceof Error ? error.message : "Failed to update task.";
      toast.error(message);
    }
  };

  const deleteDetailsSubtask = async (subtaskId: string) => {
    const ticketId = detailsForm?.id;
    if (!ticketId) {
      return;
    }

    let previous: TicketSubtask[] = [];
    setSubtasksByTicketId((prev) => {
      previous = [...(prev[ticketId] ?? [])];
      const next = previous.filter((item) => item.id !== subtaskId);
      setTicketChecklistCounts(
        ticketId,
        next.filter((item) => item.completed).length,
        next.length,
      );
      return {
        ...prev,
        [ticketId]: next,
      };
    });

    try {
      await adapter.deleteTicketSubtask(subtaskId);
      toast.success("Task removed");
      const subtaskTitle = previous.find((item) => item.id === subtaskId)?.title ?? "subtask";
      await createTicketActivity(
        ticketId,
        "Task removed",
        `Removed ${subtaskTitle === "subtask" ? "a subtask" : `"${subtaskTitle}"`}.`,
        "warning",
      );
    } catch (error) {
      setSubtasksByTicketId((prev) => ({
        ...prev,
        [ticketId]: previous,
      }));
      setTicketChecklistCounts(
        ticketId,
        previous.filter((item) => item.completed).length,
        previous.length,
      );
      const message = error instanceof Error ? error.message : "Failed to remove task.";
      toast.error(message);
    }
  };

  const renameDetailsChecklist = async (oldName: string, newName: string) => {
    const ticketId = detailsForm?.id;
    if (!ticketId || !oldName || !newName || oldName === newName) return;

    setSubtasksByTicketId((prev) => {
      const next = (prev[ticketId] ?? []).map((item) =>
        item.checklistName === oldName ? { ...item, checklistName: newName } : item,
      );
      return { ...prev, [ticketId]: next };
    });
    setSubtaskDraftsByChecklist((prev) => {
      if (!(oldName in prev)) return prev;
      const { [oldName]: draft, ...rest } = prev;
      return { ...rest, [newName]: draft };
    });

    try {
      await adapter.renameTicketChecklist(ticketId, oldName, newName);
    } catch (error) {
      setSubtasksByTicketId((prev) => {
        const next = (prev[ticketId] ?? []).map((item) =>
          item.checklistName === newName ? { ...item, checklistName: oldName } : item,
        );
        return { ...prev, [ticketId]: next };
      });
      const message = error instanceof Error ? error.message : "Failed to rename checklist.";
      toast.error(message);
    }
  };

  const deleteDetailsChecklist = async (checklistName: string) => {
    const ticketId = detailsForm?.id;
    if (!ticketId) return;

    let previous: TicketSubtask[] = [];
    setSubtasksByTicketId((prev) => {
      previous = prev[ticketId] ?? [];
      const next = previous.filter((item) => item.checklistName !== checklistName);
      setTicketChecklistCounts(
        ticketId,
        next.filter((item) => item.completed).length,
        next.length,
      );
      return { ...prev, [ticketId]: next };
    });
    setSubtaskDraftsByChecklist((prev) => {
      const { [checklistName]: _removed, ...rest } = prev;
      return rest;
    });

    try {
      await adapter.deleteTicketChecklist(ticketId, checklistName);
      toast.success("Checklist removed");
      await createTicketActivity(ticketId, "Checklist removed", `Removed checklist "${checklistName}".`, "warning");
    } catch (error) {
      setSubtasksByTicketId((prev) => ({ ...prev, [ticketId]: previous }));
      setTicketChecklistCounts(
        ticketId,
        previous.filter((item) => item.completed).length,
        previous.length,
      );
      const message = error instanceof Error ? error.message : "Failed to delete checklist.";
      toast.error(message);
    }
  };

  const loadTicketComments = async (ticketId: string) => {
    setLoadingCommentsTicketId(ticketId);
    try {
      const rows = await adapter.listTicketComments(ticketId);
      const comments = rows.map(toTicketComment);
      setCommentsByTicketId((prev) => ({
        ...prev,
        [ticketId]: comments,
      }));
      setTicketCommentCount(ticketId, comments.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load comments.";
      toast.error(message);
    } finally {
      setLoadingCommentsTicketId((current) => (current === ticketId ? null : current));
    }
  };

  const loadTicketActivity = async (ticketId: string) => {
    setLoadingActivityTicketId(ticketId);
    try {
      const rows = await adapter.listTicketActivity(ticketId);
      const activity = rows.map(toTicketActivity);
      setActivityByTicketId((prev) => ({
        ...prev,
        [ticketId]: activity,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load activity.";
      toast.error(message);
    } finally {
      setLoadingActivityTicketId((current) => (current === ticketId ? null : current));
    }
  };

  const createTicketActivity = async (
    ticketId: string,
    event: string,
    details: string,
    level: TicketActivity["level"] = "info",
  ) => {
    if (!ticketId) {
      return;
    }

    try {
      const created = await adapter.createTicketActivity(ticketId, {
        source: "Tasks",
        event,
        details,
        level,
      });

      setActivityByTicketId((prev) => {
        const next = [toTicketActivity(created), ...(prev[ticketId] ?? [])];
        return {
          ...prev,
          [ticketId]: next,
        };
      });
    } catch {
      // Activity logging should never block the core ticket action.
    }
  };

  const addDetailsComment = async () => {
    const ticketId = detailsForm?.id;
    const content = commentDraft.trim();
    if (!ticketId || !content) {
      return;
    }

    setCommentDraft("");
    try {
      const created = await adapter.createTicketComment(ticketId, content);
      setCommentsByTicketId((prev) => {
        const next = [...(prev[ticketId] ?? []), toTicketComment(created)];
        setTicketCommentCount(ticketId, next.length);
        return {
          ...prev,
          [ticketId]: next,
        };
      });
      toast.success("Comment added");
      await createTicketActivity(ticketId, "Comment added", "Added a comment.", "success");
    } catch (error) {
      setCommentDraft(content);
      const message = error instanceof Error ? error.message : "Failed to add comment.";
      toast.error(message);
    }
  };

  const deleteDetailsComment = async (commentId: string) => {
    const ticketId = detailsForm?.id;
    if (!ticketId) {
      return;
    }

    let previous: TicketComment[] = [];
    setCommentsByTicketId((prev) => {
      previous = [...(prev[ticketId] ?? [])];
      const next = previous.filter((item) => item.id !== commentId);
      setTicketCommentCount(ticketId, next.length);
      return {
        ...prev,
        [ticketId]: next,
      };
    });

    try {
      await adapter.deleteTicketComment(commentId);
      toast.success("Comment removed");
      const deleted = previous.find((item) => item.id === commentId) ?? null;
      await createTicketActivity(
        ticketId,
        "Comment removed",
        deleted
          ? `Removed a comment from ${deleted.authorName}.`
          : "Removed a comment.",
        "warning",
      );
    } catch (error) {
      setCommentsByTicketId((prev) => ({
        ...prev,
        [ticketId]: previous,
      }));
      setTicketCommentCount(ticketId, previous.length);
      const message = error instanceof Error ? error.message : "Failed to remove comment.";
      toast.error(message);
    }
  };

  const openCreateBoardModal = () => {
    rememberTrigger();
    setCreateBoardTitle("");
    setCreateBoardDescription("");
    setCreateBoardError("");
    setCreateBoardOpen(true);
  };

  const closeCreateBoardModal = () => {
    setCreateBoardOpen(false);
    restoreFocus();
  };

  const openEditBoardModal = (boardId: string) => {
    const boardEntry = boardMap[boardId];
    if (!boardEntry) {
      return;
    }
    rememberTrigger();
    setEditBoardId(boardId);
    setEditBoardTitle(boardEntry.name);
    setEditBoardDescription(boardEntry.description);
    setEditBoardError("");
    setEditBoardOpen(true);
  };

  const closeEditBoardModal = () => {
    setEditBoardOpen(false);
    restoreFocus();
  };

  const openCreateListModal = () => {
    rememberTrigger();
    setCreateListTitle("");
    setCreateListError("");
    setCreateListOpen(true);
  };

  const closeCreateListModal = () => {
    setCreateListOpen(false);
    restoreFocus();
  };

  const closeCreateModal = () => {
    if (createDirty) {
      setDiscardTarget("create");
      setModal("discard");
      return;
    }
    setModal(null);
    restoreFocus();
  };

  const closeDetailsModal = () => {
    if (detailsDirty) {
      setDiscardTarget("details");
      setModal("discard");
      return;
    }
    setSubtaskDraftsByChecklist({});
    setCommentDraft("");
    setModal(null);
    restoreFocus();
  };

  const keepEditing = () => {
    setModal(discardTarget === "create" ? "create" : "details");
    setDiscardTarget(null);
  };

  const discardChanges = () => {
    if (discardTarget === "create") setCreateForm(createSnapshot);
    if (discardTarget === "details") setDetailsForm(detailsSnapshot);
    setDiscardTarget(null);
    setModal(null);
    restoreFocus();
  };

  const handleCreateBoard = async () => {
    const title = createBoardTitle.trim();
    const description = createBoardDescription.trim();
    if (!title) {
      setCreateBoardError("Board name is required.");
      return;
    }

    try {
      const newBoard = await adapter.createBoard({
        name: title,
        description,
      });

      const defaultColumns = await Promise.all(
        defaultBoardColumns.map((column) =>
          adapter.createColumn(newBoard.id, {
            title: column.title,
            colorKey: column.colorKey,
            isDefault: column.isDefault,
          }),
        ),
      );

      const newBoardEntry: BoardEntry = {
        id: newBoard.id,
        name: newBoard.name,
        description: newBoard.description,
        data: buildBoardState(defaultColumns, []),
      };

      setBoardMap((prev) => ({
        ...prev,
        [newBoard.id]: newBoardEntry,
      }));
      setBoardOrder((prev) => [...prev, newBoard.id]);
      setActiveBoardId(newBoard.id);

      setCreateBoardOpen(false);
      setCreateBoardTitle("");
      setCreateBoardDescription("");
      setCreateBoardError("");
      toast.success("Board created");
      restoreFocus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create board.";
      setCreateBoardError(message);
      toast.error(message);
    }
  };

  const handleDeleteBoard = async (boardId: string) => {
    const existingBoard = boardMap[boardId];
    if (!existingBoard) {
      return false;
    }

    const previousBoardMap = boardMap;
    const previousBoardOrder = boardOrder;
    const previousActiveBoardId = activeBoardId;

    const nextBoardOrder = boardOrder.filter((id) => id !== boardId);
    const nextBoardMap = { ...boardMap };
    delete nextBoardMap[boardId];

    const nextActiveBoardId =
      activeBoardId === boardId ? (nextBoardOrder[0] ?? "") : activeBoardId;

    setBoardMap(nextBoardMap);
    setBoardOrder(nextBoardOrder);
    setActiveBoardId(nextActiveBoardId);

    if (activeBoardId === boardId) {
      setModal(null);
      setDiscardTarget(null);
      setDetailsForm(null);
      setDetailsSnapshot(null);
      clearSearch();
    }

    try {
      await adapter.deleteBoard(boardId);
      toast.success("Board deleted");
      return true;
    } catch (error) {
      setBoardMap(previousBoardMap);
      setBoardOrder(previousBoardOrder);
      setActiveBoardId(previousActiveBoardId);
      const message = error instanceof Error ? error.message : "Failed to delete board.";
      toast.error(message);
      return false;
    }
  };

  const handleUpdateBoard = async () => {
    const boardId = editBoardId;
    const title = editBoardTitle.trim();
    const description = editBoardDescription.trim();
    if (!boardId || !boardMap[boardId]) {
      setEditBoardError("Board not found.");
      return;
    }
    if (!title) {
      setEditBoardError("Board name is required.");
      return;
    }

    try {
      const updated = await adapter.updateBoard(boardId, {
        name: title,
        description,
      });

      setBoardMap((prev) => {
        const boardEntry = prev[boardId];
        if (!boardEntry) {
          return prev;
        }
        return {
          ...prev,
          [boardId]: {
            ...boardEntry,
            name: updated.name,
            description: updated.description,
          },
        };
      });

      setEditBoardOpen(false);
      setEditBoardError("");
      toast.success("Board updated");
      restoreFocus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update board.";
      setEditBoardError(message);
      toast.error(message);
    }
  };

  const handleCopyBoard = async (boardId: string) => {
    const source = boardMap[boardId];
    if (!source) {
      return null;
    }

    try {
      const copiedBoard = await adapter.createBoard({
        name: `${source.name} (Copy)`,
        description: source.description,
      });

      const columnIdMap: Record<string, string> = {};
      const createdColumns: ColumnRecord[] = [];
      for (const sourceColumnId of source.data.columnOrder) {
        const sourceColumn = source.data.columns[sourceColumnId];
        if (!sourceColumn) {
          continue;
        }
        const createdColumn = await adapter.createColumn(copiedBoard.id, {
          title: sourceColumn.title,
          colorKey: colorKeyFromTone(sourceColumn.tone),
          isDefault: sourceColumn.isDefault,
        });
        columnIdMap[sourceColumnId] = createdColumn.id;
        createdColumns.push(createdColumn);
      }

      const createdTickets: TicketRecord[] = [];
      for (const sourceColumnId of source.data.columnOrder) {
        const nextColumnId = columnIdMap[sourceColumnId];
        if (!nextColumnId) {
          continue;
        }

        const ticketIds = source.data.ticketIdsByColumn[sourceColumnId] ?? [];
        for (const ticketId of ticketIds) {
          const sourceTicket = source.data.tickets[ticketId];
          if (!sourceTicket) {
            continue;
          }

          const createdTicket = await adapter.createTicket(copiedBoard.id, {
            columnId: nextColumnId,
            title: sourceTicket.title,
            description: sourceTicket.description,
            priority: sourceTicket.priority,
            dueDate: toIsoDueDate(sourceTicket.dueDate ?? ""),
            tags: [...sourceTicket.tags],
            assigneeIds: validAssigneeIds([...sourceTicket.assigneeIds]),
            checklistDone: sourceTicket.checklistDone,
            checklistTotal: sourceTicket.checklistTotal,
            attachmentsCount: 0,
            commentsCount: sourceTicket.comments,
          });
          createdTickets.push(createdTicket);
        }
      }

      const nextBoardEntry: BoardEntry = {
        id: copiedBoard.id,
        name: copiedBoard.name,
        description: copiedBoard.description,
        data: buildBoardState(createdColumns, createdTickets),
      };

      setBoardMap((prev) => ({
        ...prev,
        [copiedBoard.id]: nextBoardEntry,
      }));
      setBoardOrder((prev) => [...prev, copiedBoard.id]);

      toast.success("Board copied");
      return copiedBoard.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to copy board.";
      toast.error(message);
      return null;
    }
  };

  const handleCreateTicket = async (
    files: File[] = [],
    draftSubtasks: { checklistName: string; title: string }[] = [],
  ) => {
    const title = createForm.title.trim();
    if (!title) {
      setCreateError("Title is required.");
      toast.error("Title is required.");
      return;
    }

    const tags = createForm.tagsText
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const assigneeIds = validAssigneeIds(createForm.assigneeIds);

    const tempId = `temp-${Date.now()}`;
    let rollbackBoard: BoardState | null = null;
    let targetColumnId = "";
    let beforeTicketId: string | null = null;

    updateActiveBoard((prev) => {
      rollbackBoard = cloneBoard(prev);

      const nextTargetColumnId = prev.columns[createForm.statusId]
        ? createForm.statusId
        : prev.columnOrder[0];
      if (!nextTargetColumnId) return prev;

      targetColumnId = nextTargetColumnId;
      beforeTicketId = prev.ticketIdsByColumn[nextTargetColumnId]?.[0] ?? null;

      const newTicket: Ticket = {
        id: tempId,
        title,
        description: createForm.description.trim(),
        statusId: nextTargetColumnId,
        priority: createForm.priority,
        dueDate: createForm.dueDate || null,
        tags,
        assigneeIds,
        scheduledFor: createForm.scheduledFor || null,
        checklistDone: 0,
        checklistTotal: 0,
        comments: 0,
        attachments: 0,
        createdAt: Date.now(),
      };

      const nextTicketIdsByColumn = { ...prev.ticketIdsByColumn };
      nextTicketIdsByColumn[nextTargetColumnId] = [tempId, ...(nextTicketIdsByColumn[nextTargetColumnId] ?? [])];

      return {
        ...prev,
        tickets: { ...prev.tickets, [tempId]: newTicket },
        ticketIdsByColumn: nextTicketIdsByColumn,
      };
    });

    setModal(null);
    restoreFocus();

    if (!targetColumnId) {
      toast.error("Create a list before adding a ticket.");
      return;
    }

    const payload: CreateTicketPayload = {
      columnId: targetColumnId,
      title,
      description: createForm.description.trim(),
      priority: createForm.priority,
      dueDate: toIsoDueDate(createForm.dueDate),
      scheduledFor: toIsoDueDate(createForm.scheduledFor),
      tags,
      assigneeIds,
      checklistDone: 0,
      checklistTotal: 0,
      attachmentsCount: 0,
      commentsCount: 0,
      beforeTicketId,
    };

    try {
      const created = await adapter.createTicket(activeBoardId, payload);
      let uploadedCount = 0;
      if (files.length > 0) {
        for (const file of files) {
          await adapter.uploadTicketAttachment(created.id, file);
          uploadedCount += 1;
        }
      }

      updateActiveBoard((prev) => {
        const tempTicket = prev.tickets[tempId];
        if (!tempTicket) return prev;

        const nextTickets = { ...prev.tickets };
        delete nextTickets[tempId];
        nextTickets[created.id] = {
          ...tempTicket,
          id: created.id,
          statusId: created.columnId,
          priority: created.priority,
          dueDate: formatDueDateInput(created.dueDate),
          scheduledFor: formatDueDateInput(created.scheduledFor),
          checklistDone: created.checklistDone,
          checklistTotal: created.checklistTotal,
          comments: created.commentsCount,
          attachments: created.attachmentsCount + uploadedCount,
          createdAt: new Date(created.createdAt).valueOf(),
        };

        const nextTicketIdsByColumn: Record<string, string[]> = {};
        for (const [columnId, ticketIds] of Object.entries(prev.ticketIdsByColumn)) {
          nextTicketIdsByColumn[columnId] = ticketIds.map((ticketId) =>
            ticketId === tempId ? created.id : ticketId,
          );
        }

        return {
          ...prev,
          tickets: nextTickets,
          ticketIdsByColumn: nextTicketIdsByColumn,
        };
      });

      const assignedNames = assigneeIds
        .map((id) => resolveAssigneeName(id))
        .filter((name): name is string => Boolean(name));
      const detailParts = [
        targetColumnId ? `Created in ${board.columns[targetColumnId]?.title ?? "list"}.` : "Created ticket.",
      ];
      if (assignedNames.length > 0) {
        detailParts.push(`Assigned to ${assignedNames.join(", ")}.`);
      }
      if (uploadedCount > 0) {
        detailParts.push(`Uploaded ${uploadedCount} attachment${uploadedCount === 1 ? "" : "s"}.`);
      }
      await createTicketActivity(created.id, "Ticket created", detailParts.join(" "), "success");

      // Create any draft subtasks from create mode
      if (draftSubtasks.length > 0) {
        const createdSubtasks: TicketSubtask[] = [];
        for (const ds of draftSubtasks) {
          try {
            const sub = await adapter.createTicketSubtask(created.id, {
              title: ds.title,
              checklistName: ds.checklistName,
            });
            createdSubtasks.push(toTicketSubtask(sub));
          } catch {
            // non-fatal; ticket was created, subtask can be added manually
          }
        }
        if (createdSubtasks.length > 0) {
          setSubtasksByTicketId((prev) => ({
            ...prev,
            [created.id]: createdSubtasks,
          }));
          updateActiveBoard((prev) => {
            const ticket = prev.tickets[created.id];
            if (!ticket) return prev;
            return {
              ...prev,
              tickets: {
                ...prev.tickets,
                [created.id]: {
                  ...ticket,
                  checklistTotal: createdSubtasks.length,
                  checklistDone: createdSubtasks.filter((s) => s.completed).length,
                },
              },
            };
          });
        }
      }

      toast.success(
        uploadedCount > 0 ? `Ticket created with ${uploadedCount} attachment(s)` : "Ticket created",
      );
    } catch (error) {
      if (rollbackBoard) {
        updateActiveBoard(() => rollbackBoard as BoardState);
      }
      const message = error instanceof Error ? error.message : "Failed to create ticket.";
      toast.error(message);
    }
  };

  const handleDeleteTicket = async (ticketId: string) => {
    const ticket = activeBoardRef.current.tickets[ticketId];
    if (!ticket) {
      return;
    }

    let rollbackBoard: BoardState | null = null;

    updateActiveBoard((prev) => {
      const currentTicket = prev.tickets[ticketId];
      if (!currentTicket) {
        return prev;
      }

      rollbackBoard = cloneBoard(prev);
      const nextTickets = { ...prev.tickets };
      delete nextTickets[ticketId];

      const nextTicketIdsByColumn = { ...prev.ticketIdsByColumn };
      nextTicketIdsByColumn[currentTicket.statusId] = (
        nextTicketIdsByColumn[currentTicket.statusId] ?? []
      ).filter((id) => id !== ticketId);

      return {
        ...prev,
        tickets: nextTickets,
        ticketIdsByColumn: nextTicketIdsByColumn,
      };
    });

    if (detailsForm?.id === ticketId) {
      setDetailsForm(null);
      setDetailsSnapshot(null);
      setModal(null);
      restoreFocus();
    }
    setAttachmentsByTicketId((prev) => {
      if (!prev[ticketId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[ticketId];
      return next;
    });
    setSubtasksByTicketId((prev) => {
      if (!prev[ticketId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[ticketId];
      return next;
    });
    setCommentsByTicketId((prev) => {
      if (!prev[ticketId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[ticketId];
      return next;
    });
    setActivityByTicketId((prev) => {
      if (!prev[ticketId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[ticketId];
      return next;
    });

    try {
      await createTicketActivity(ticketId, "Ticket deleted", "Deleted this ticket.", "error");
      await adapter.deleteTicket(ticketId);
      toast.success("Ticket deleted");
    } catch (error) {
      if (rollbackBoard) {
        updateActiveBoard(() => rollbackBoard as BoardState);
      }
      const message = error instanceof Error ? error.message : "Failed to delete ticket.";
      toast.error(message);
    }
  };

  const handleCopyTicket = async (ticketId: string) => {
    if (!activeBoardId) {
      return;
    }

    const sourceBoard = activeBoardRef.current;
    const sourceTicket = sourceBoard.tickets[ticketId];
    if (!sourceTicket) {
      return;
    }

    const sourceColumnId = sourceTicket.statusId;
    const ticketIds = sourceBoard.ticketIdsByColumn[sourceColumnId] ?? [];
    const sourceIndex = ticketIds.indexOf(ticketId);
    const beforeTicketId = sourceIndex >= 0 ? ticketIds[sourceIndex + 1] ?? null : null;

    try {
      const copied = await adapter.createTicket(activeBoardId, {
        columnId: sourceColumnId,
        title: `${sourceTicket.title} (Copy)`,
        description: sourceTicket.description,
        priority: sourceTicket.priority,
        dueDate: toIsoDueDate(sourceTicket.dueDate ?? ""),
        tags: [...sourceTicket.tags],
        assigneeIds: validAssigneeIds([...sourceTicket.assigneeIds]),
        checklistDone: sourceTicket.checklistDone,
        checklistTotal: sourceTicket.checklistTotal,
        attachmentsCount: 0,
        commentsCount: sourceTicket.comments,
        beforeTicketId,
      });

      updateActiveBoard((prev) => {
        if (!prev.columns[sourceColumnId]) {
          return prev;
        }

        const nextTickets = { ...prev.tickets, [copied.id]: toTicket(copied) };
        const nextTicketIds = [...(prev.ticketIdsByColumn[sourceColumnId] ?? [])];
        const currentIndex = nextTicketIds.indexOf(ticketId);
        const insertIndex = currentIndex >= 0 ? currentIndex + 1 : nextTicketIds.length;
        nextTicketIds.splice(insertIndex, 0, copied.id);

        return {
          ...prev,
          tickets: nextTickets,
          ticketIdsByColumn: {
            ...prev.ticketIdsByColumn,
            [sourceColumnId]: nextTicketIds,
          },
        };
      });

      await createTicketActivity(
        copied.id,
        "Ticket created",
        `Created as a copy of "${sourceTicket.title}".`,
        "success",
      );
      toast.success("Ticket copied");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to copy ticket.";
      toast.error(message);
    }
  };

  const handleCreateList = async () => {
    const title = createListTitle.trim();
    if (!title) {
      setCreateListError("List name is required.");
      return;
    }

    if (!activeBoardId) {
      setCreateListError("Select a board first.");
      return;
    }

    const tempColumnId = `temp-column-${Date.now()}`;
    let rollbackBoard: BoardState | null = null;

    updateActiveBoard((prev) => {
      rollbackBoard = cloneBoard(prev);
      return {
        ...prev,
        columns: {
          ...prev.columns,
          [tempColumnId]: { id: tempColumnId, title, tone: "neutral", isDefault: false },
        },
        columnOrder: [...prev.columnOrder, tempColumnId],
        ticketIdsByColumn: {
          ...prev.ticketIdsByColumn,
          [tempColumnId]: [],
        },
      };
    });

    setCreateListOpen(false);
    setCreateListTitle("");
    setCreateListError("");
    restoreFocus();

    try {
      const created = await adapter.createColumn(activeBoardId, {
        title,
        colorKey: "neutral",
        isDefault: false,
      });

      updateActiveBoard((prev) => {
        const tempColumn = prev.columns[tempColumnId];
        if (!tempColumn) return prev;

        const nextColumns = { ...prev.columns };
        delete nextColumns[tempColumnId];
        nextColumns[created.id] = {
          id: created.id,
          title: created.title,
          tone: toneFromColorKey(created.colorKey),
          isDefault: created.isDefault,
        };

        const nextColumnOrder = prev.columnOrder.map((columnId) =>
          columnId === tempColumnId ? created.id : columnId,
        );

        const nextTicketIdsByColumn: Record<string, string[]> = {};
        for (const [columnId, ticketIds] of Object.entries(prev.ticketIdsByColumn)) {
          nextTicketIdsByColumn[columnId === tempColumnId ? created.id : columnId] = [...ticketIds];
        }

        return {
          ...prev,
          columns: nextColumns,
          columnOrder: nextColumnOrder,
          ticketIdsByColumn: nextTicketIdsByColumn,
        };
      });

      toast.success("List created");
    } catch (error) {
      if (rollbackBoard) {
        updateActiveBoard(() => rollbackBoard as BoardState);
      }
      const message = error instanceof Error ? error.message : "Failed to create list.";
      toast.error(message);
    }
  };

  const canDeleteList = (columnId: string) => {
    const column = activeBoardRef.current.columns[columnId];
    if (!column) {
      return false;
    }
    const normalizedTitle = column.title.trim().toLowerCase();
    if (column.isDefault || DEFAULT_LOCKED_LIST_TITLES.has(normalizedTitle)) {
      return false;
    }
    return true;
  };

  const handleDeleteList = async (columnId: string) => {
    const currentBoard = activeBoardRef.current;
    const column = currentBoard.columns[columnId];
    if (!column) {
      return;
    }

    if (!canDeleteList(columnId)) {
      toast.error("Default lists cannot be deleted.");
      return;
    }

    if (currentBoard.columnOrder.length <= 1) {
      toast.error("At least one list is required.");
      return;
    }

    const ticketIds = currentBoard.ticketIdsByColumn[columnId] ?? [];
    if (ticketIds.length > 0) {
      toast.error("Move or delete tickets before deleting this list.");
      return;
    }

    const previousBoard = cloneBoard(currentBoard);
    const nextColumns = { ...currentBoard.columns };
    delete nextColumns[columnId];

    const nextColumnOrder = currentBoard.columnOrder.filter((id) => id !== columnId);
    const nextTicketIdsByColumn = { ...currentBoard.ticketIdsByColumn };
    delete nextTicketIdsByColumn[columnId];

    updateActiveBoard(() => ({
      ...currentBoard,
      columns: nextColumns,
      columnOrder: nextColumnOrder,
      ticketIdsByColumn: nextTicketIdsByColumn,
    }));

    setCreateForm((prev) => {
      if (prev.statusId !== columnId) {
        return prev;
      }
      return {
        ...prev,
        statusId: nextColumnOrder[0] ?? "",
      };
    });

    try {
      await adapter.deleteColumn(columnId);
      toast.success("List deleted");
    } catch (error) {
      updateActiveBoard(() => previousBoard);
      const message = error instanceof Error ? error.message : "Failed to delete list.";
      toast.error(message);
    }
  };

  const handleSaveDetails = async () => {
    if (!detailsForm) return;
    const baseline =
      detailsSnapshot && detailsSnapshot.id === detailsForm.id ? detailsSnapshot : null;
    const title = detailsForm.title.trim();
    if (!title) return;

    const tags = detailsForm.tagsText
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    const assigneeIds = validAssigneeIds(detailsForm.assigneeIds);

    let rollbackBoard: BoardState | null = null;
    let nextStatusId = detailsForm.statusId;
    let previousStatusId: string | null = null;

    updateActiveBoard((prev) => {
      rollbackBoard = cloneBoard(prev);

      const current = prev.tickets[detailsForm.id];
      if (!current) return prev;
      previousStatusId = current.statusId;

      nextStatusId = prev.columns[detailsForm.statusId] ? detailsForm.statusId : current.statusId;
      const nextTicket: Ticket = {
        ...current,
        title,
        description: detailsForm.description.trim(),
        statusId: nextStatusId,
        priority: detailsForm.priority,
        dueDate: detailsForm.dueDate || null,
        tags,
        assigneeIds,
        scheduledFor: detailsForm.scheduledFor || null,
        checklistDone: detailsForm.checklistDone,
        checklistTotal: detailsForm.checklistTotal,
        comments: detailsForm.comments,
        attachments: detailsForm.attachments,
      };

      const nextTicketIdsByColumn = { ...prev.ticketIdsByColumn };
      if (current.statusId !== nextStatusId) {
        nextTicketIdsByColumn[current.statusId] = (nextTicketIdsByColumn[current.statusId] ?? []).filter(
          (id) => id !== detailsForm.id,
        );
        nextTicketIdsByColumn[nextStatusId] = [detailsForm.id, ...(nextTicketIdsByColumn[nextStatusId] ?? [])];
      }

      return {
        ...prev,
        tickets: { ...prev.tickets, [detailsForm.id]: nextTicket },
        ticketIdsByColumn: nextTicketIdsByColumn,
      };
    });

    setModal(null);
    restoreFocus();

    try {
      await adapter.updateTicket(detailsForm.id, {
        title,
        description: detailsForm.description.trim(),
        priority: detailsForm.priority,
        dueDate: toIsoDueDate(detailsForm.dueDate),
        scheduledFor: toIsoDueDate(detailsForm.scheduledFor),
        tags,
        assigneeIds,
        checklistDone: detailsForm.checklistDone,
        checklistTotal: detailsForm.checklistTotal,
        commentsCount: detailsForm.comments,
        attachmentsCount: detailsForm.attachments,
      });

      const latestBoard = activeBoardRef.current;
      const currentTicket = latestBoard.tickets[detailsForm.id];
      if (currentTicket && currentTicket.statusId !== (previousStatusId ?? currentTicket.statusId)) {
        const ids = latestBoard.ticketIdsByColumn[nextStatusId] ?? [];
        const currentIndex = ids.indexOf(detailsForm.id);
        const beforeTicketId = currentIndex >= 0 ? ids[currentIndex + 1] ?? null : null;
        await adapter.moveTicket(detailsForm.id, {
          toColumnId: nextStatusId,
          beforeTicketId,
        });
      }

      if (baseline) {
        const activityEntries: Array<{
          event: string;
          details: string;
          level?: TicketActivity["level"];
        }> = [];

        if (!sameText(baseline.title, title)) {
          activityEntries.push({
            event: "Title updated",
            details: `Renamed ticket to "${title}".`,
            level: "info",
          });
        }

        if (!sameText(baseline.description, detailsForm.description.trim())) {
          activityEntries.push({
            event: "Description updated",
            details: "Updated the ticket description.",
            level: "info",
          });
        }

        if (baseline.statusId !== nextStatusId) {
          const previousLabel = board.columns[baseline.statusId]?.title ?? "Unknown";
          const nextLabel = board.columns[nextStatusId]?.title ?? "Unknown";
          activityEntries.push({
            event: "Status changed",
            details: `Moved from ${previousLabel} to ${nextLabel}.`,
            level: "success",
          });
        }

        if (baseline.priority !== detailsForm.priority) {
          activityEntries.push({
            event: "Priority changed",
            details: `Changed priority from ${baseline.priority} to ${detailsForm.priority}.`,
            level: "warning",
          });
        }

        if (baseline.dueDate !== detailsForm.dueDate) {
          activityEntries.push({
            event: "Due date changed",
            details: detailsForm.dueDate
              ? `Set due date to ${toDueDateLabel(detailsForm.dueDate)}.`
              : "Cleared due date.",
            level: "info",
          });
        }

        const previousAssigneeIds = new Set(baseline.assigneeIds);
        const nextAssigneeIds = new Set(assigneeIds);
        const addedAssignees = assigneeIds
          .filter((id) => !previousAssigneeIds.has(id))
          .map((id) => resolveAssigneeName(id))
          .filter((name): name is string => Boolean(name));
        const removedAssignees = baseline.assigneeIds
          .filter((id) => !nextAssigneeIds.has(id))
          .map((id) => resolveAssigneeName(id))
          .filter((name): name is string => Boolean(name));

        if (addedAssignees.length > 0) {
          activityEntries.push({
            event: "Assignees added",
            details: `Assigned ${addedAssignees.join(", ")}.`,
            level: "success",
          });
        }

        if (removedAssignees.length > 0) {
          activityEntries.push({
            event: "Assignees removed",
            details: `Unassigned ${removedAssignees.join(", ")}.`,
            level: "warning",
          });
        }

        for (const entry of activityEntries) {
          await createTicketActivity(
            detailsForm.id,
            entry.event,
            entry.details,
            entry.level ?? "info",
          );
        }
      }

      toast.success("Ticket updated");
    } catch (error) {
      if (rollbackBoard) {
        updateActiveBoard(() => rollbackBoard as BoardState);
      }
      const message = error instanceof Error ? error.message : "Failed to update ticket.";
      toast.error(message);
    }
  };

  const moveColumn = (activeId: string, overId: string) => {
    const currentBoard = activeBoardRef.current;
    const order = [...currentBoard.columnOrder];
    const from = order.indexOf(activeId);
    const to = order.indexOf(overId);
    if (from < 0 || to < 0 || from === to || !activeBoardId) return;

    const previousBoard = cloneBoard(currentBoard);
    order.splice(from, 1);
    order.splice(to, 0, activeId);

    const nextBoard: BoardState = {
      ...currentBoard,
      columnOrder: order,
    };

    updateActiveBoard(() => nextBoard);

    void adapter.reorderColumns(activeBoardId, order).catch((error) => {
      updateActiveBoard(() => previousBoard);
      const message = error instanceof Error ? error.message : "Failed to reorder columns.";
      toast.error(message);
    });
  };

  const moveTicket = (
    ticketId: string,
    fromColumnId: string,
    toColumnId: string,
    toIndex: number,
    persist = true,
    persistFromColumnId?: string,
  ) => {
    const currentBoard = activeBoardRef.current;
    if (!currentBoard.ticketIdsByColumn[fromColumnId] || !currentBoard.ticketIdsByColumn[toColumnId]) {
      return;
    }

    const ticket = currentBoard.tickets[ticketId];
    if (!ticket) {
      return;
    }

    const previousBoard = cloneBoard(currentBoard);
    const nextTicketIdsByColumn = { ...currentBoard.ticketIdsByColumn };
    nextTicketIdsByColumn[fromColumnId] = nextTicketIdsByColumn[fromColumnId].filter(
      (id) => id !== ticketId,
    );
    const target = [...nextTicketIdsByColumn[toColumnId]];
    const clampedIndex = Math.max(0, Math.min(target.length, toIndex));
    target.splice(clampedIndex, 0, ticketId);
    nextTicketIdsByColumn[toColumnId] = target;

    const nextTicket =
      ticket.statusId !== toColumnId
        ? { ...ticket, statusId: toColumnId }
        : ticket;

    const nextBoard: BoardState = {
      ...currentBoard,
      tickets: { ...currentBoard.tickets, [ticketId]: nextTicket },
      ticketIdsByColumn: nextTicketIdsByColumn,
    };

    updateActiveBoard(() => nextBoard);

    if (!persist) return;

    void (async () => {
      try {
        const sourceColumnId = persistFromColumnId ?? fromColumnId;

        if (sourceColumnId === toColumnId) {
          await adapter.reorderTickets(toColumnId, nextBoard.ticketIdsByColumn[toColumnId] ?? []);
          await createTicketActivity(
            ticketId,
            "Task reordered",
            `Reordered within ${currentBoard.columns[toColumnId]?.title ?? "list"}.`,
            "info",
          );
          return;
        }

        const targetIds = nextBoard.ticketIdsByColumn[toColumnId] ?? [];
        const currentIndex = targetIds.indexOf(ticketId);
        const beforeTicketId = currentIndex >= 0 ? targetIds[currentIndex + 1] ?? null : null;

        await adapter.moveTicket(ticketId, {
          toColumnId,
          beforeTicketId,
        });
        await createTicketActivity(
          ticketId,
          "Status changed",
          `Moved from ${currentBoard.columns[sourceColumnId]?.title ?? "list"} to ${currentBoard.columns[toColumnId]?.title ?? "list"}.`,
          "success",
        );
      } catch (error) {
        updateActiveBoard(() => previousBoard);
        const message = error instanceof Error ? error.message : "Failed to move ticket.";
        toast.error(message);
      }
    })();
  };

  const clearSearch = () => {
    setSearchInput("");
    setSearchQuery("");
  };

  const reloadBoards = async () => {
    try {
      const res = await fetch("/api/tasks", { cache: "reload" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.ok) {
        const { boards: rawBoards, columns: rawColumns, tickets: rawTickets } = json;
        const hydratedBoards = hydrateBoards(
          Array.isArray(rawBoards) ? rawBoards : [],
          Array.isArray(rawColumns) ? rawColumns : [],
          Array.isArray(rawTickets) ? rawTickets : []
        );
        setBoardMap(Object.fromEntries(hydratedBoards.map((b) => [b.id, cloneBoardEntry(b)])));
        setBoardOrder(hydratedBoards.map((b) => b.id));
      }
    } catch (err) {
      console.error("reloadBoards failed:", err);
    }
  };

  return {
    board,
    boards,
    boardSummaries,
    activeBoardId,
    activeBoardName,
    activeBoardDescription,
    setActiveBoardId: selectBoard,
    view,
    setView,
    sort,
    setSort,
    searchInput,
    setSearchInput,
    searchQuery,
    clearSearch,
    modal,
    discardTarget,
    createForm,
    setCreateForm,
    createError,
    setCreateError,
    createDirty,
    detailsForm,
    setDetailsForm,
    detailsDirty,
    detailsAttachments,
    detailsAttachmentsLoading,
    detailsAttachmentsUploading,
    detailsSubtasks,
    detailsSubtasksLoading,
    detailsComments,
    detailsCommentsLoading,
    detailsActivity,
    detailsActivityLoading,
    subtaskDraftsByChecklist,
    setSubtaskDraftForChecklist,
    commentDraft,
    setCommentDraft,
    uploadDetailsAttachments,
    deleteDetailsAttachment,
    addDetailsSubtask,
    toggleDetailsSubtask,
    deleteDetailsSubtask,
    renameDetailsChecklist,
    deleteDetailsChecklist,
    addDetailsComment,
    deleteDetailsComment,
    assignees,
    assigneeById,
    filteredTicketIds,
    sortedFilteredTickets,
    visibleTicketIdsByColumn,
    renderedTicketIdsByColumn,
    hiddenCountByColumn,
    expandColumn,
    collapseColumn,
    expandedColumnIds,
    listPageSize: LIST_PAGE_SIZE,
    assigneeFilter,
    toggleAssigneeFilter,
    clearAssigneeFilter,
    totalVisible: sortedFilteredTickets.length,
    openCreateModal,
    openDetailsModal,
    closeCreateModal,
    closeDetailsModal,
    keepEditing,
    discardChanges,
    handleCreateTicket,
    handleCopyTicket,
    handleDeleteTicket,
    createBoardOpen,
    createBoardTitle,
    createBoardDescription,
    createBoardError,
    setCreateBoardTitle,
    setCreateBoardDescription,
    openCreateBoardModal,
    closeCreateBoardModal,
    handleCreateBoard,
    handleCopyBoard,
    handleDeleteBoard,
    editBoardOpen,
    editBoardTitle,
    editBoardDescription,
    editBoardError,
    setEditBoardTitle,
    setEditBoardDescription,
    openEditBoardModal,
    closeEditBoardModal,
    handleUpdateBoard,
    createListOpen,
    createListTitle,
    createListError,
    setCreateListTitle,
    openCreateListModal,
    closeCreateListModal,
    canDeleteList,
    handleDeleteList,
    handleCreateList,
    handleSaveDetails,
    moveColumn,
    moveTicket,
    reloadBoards,
  };
}
