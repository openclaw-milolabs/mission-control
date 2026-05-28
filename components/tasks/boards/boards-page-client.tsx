"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { GridView } from "@/components/tasks/grid/grid-view";
import { KanbanView } from "@/components/tasks/kanban/kanban-view";
import { ListView } from "@/components/tasks/list/list-view";
import { CreateBoardModal } from "@/components/tasks/modals/create-board-modal";
import { CreateListModal } from "@/components/tasks/modals/create-list-modal";
import { DiscardModal } from "@/components/tasks/modals/discard-modal";
import { ManageAssigneesModal } from "@/components/tasks/modals/manage-assignees-modal";
import { TicketDetailsModal } from "@/components/tasks/modals/ticket-details-modal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTasks } from "@/hooks/use-tasks";
import { cn } from "@/lib/utils";
import {
  type Assignee,
  type BoardHydration,
  type TicketDetailsForm,
  type SortMode,
  type ViewMode,
} from "@/types/tasks";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ChevronLeftIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  LayoutGridIcon,
} from "lucide-react";
import { BoardActivityFeed, type LiveLog } from "@/components/tasks/boards/board-activity-feed";

// UTC date formatting to avoid hydration mismatches
const pad = (n: number) => String(n).padStart(2, "0");
const formatDateUTC = (value: string | number | null | undefined): string => {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  return `${month}/${day}/${year}`;
};

const formatDateTimeUTC = (value: string | number | null | undefined): string => {
  if (!value) return "No tasks yet";
  const d = typeof value === "string" ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  return `${month}/${day}/${year}, ${hours}:${minutes} UTC`;
};

const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "dueDate", label: "Due date" },
  { key: "title", label: "Title" },
];

const VIEW_OPTIONS: Array<{ key: ViewMode; label: string }> = [
  { key: "kanban", label: "Kanban" },
  { key: "list", label: "List" },
  { key: "grid", label: "Grid" },
];

type Props = {
  initialBoardId: string | null;
  initialBoards: BoardHydration[];
  initialAssignees: Assignee[];
  sidebarUser: {
    name: string;
    email: string;
    avatar: string;
  } | null;
};

type RawBoardAssignee = { id: string; board_id: string; name: string; color: string; initials: string | null };

function deriveInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  return parts.map((p) => p[0]?.toUpperCase() || "").join("");
}

function groupAssigneesByBoard(rows: RawBoardAssignee[]): Record<string, Assignee[]> {
  const out: Record<string, Assignee[]> = {};
  for (const row of rows) {
    if (!out[row.board_id]) out[row.board_id] = [];
    out[row.board_id].push({
      id: row.id,
      name: row.name,
      initials: row.initials || deriveInitials(row.name),
      color: row.color,
    });
  }
  return out;
}

async function postTasks<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string } & T> {
  try {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return json as { ok: boolean; error?: string } & T;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" } as { ok: boolean; error?: string } & T;
  }
}

export function BoardsPageClient({ initialBoardId, initialBoards, initialAssignees: _ignored, sidebarUser }: Props) {
  void _ignored;
  const [assigneesByBoardId, setAssigneesByBoardId] = useState<Record<string, Assignee[]>>({});
  const [manageAssigneesOpen, setManageAssigneesOpen] = useState(false);

  const reloadAssignees = async () => {
    try {
      const res = await fetch("/api/tasks", { cache: "reload" });
      if (!res.ok) return;
      const json = await res.json();
      if (json.ok && Array.isArray(json.boardAssignees)) {
        setAssigneesByBoardId(groupAssigneesByBoard(json.boardAssignees as RawBoardAssignee[]));
      }
    } catch { /* ignore */ }
  };

  useEffect(() => { void reloadAssignees(); }, []);

  const tasks = useTasks({ initialBoardId, initialBoards, assigneesByBoardId });
  const router = useRouter();
  const searchParams = useSearchParams();
  const [boardSearch, setBoardSearch] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(Boolean(initialBoardId));
  const [boardActivity, setBoardActivity] = useState<LiveLog[]>([]);
  const [boardActivityLoading, setBoardActivityLoading] = useState(false);

  // Confirmation modal state
  const [deleteBoardId, setDeleteBoardId] = useState<string | null>(null);
  const [deleteBoardName, setDeleteBoardName] = useState("");
  const [copyBoardId, setCopyBoardId] = useState<string | null>(null);
  const [copyBoardName, setCopyBoardName] = useState("");
  const [copyAndOpen, setCopyAndOpen] = useState(false);

  const boardParam = searchParams.get("board");

  const handleCreateAssignee = async (name: string, color: string) => {
    if (!tasks.activeBoardId) return { ok: false, error: "No active board." };
    const res = await postTasks({ action: "createBoardAssignee", boardId: tasks.activeBoardId, name, color });
    if (res.ok) await reloadAssignees();
    return { ok: res.ok, error: res.error };
  };

  const handleUpdateAssignee = async (assigneeId: string, name: string, color: string) => {
    const res = await postTasks({ action: "updateBoardAssignee", assigneeId, name, color });
    if (res.ok) await reloadAssignees();
    return { ok: res.ok, error: res.error };
  };

  const handleDeleteAssignee = async (assigneeId: string) => {
    const res = await postTasks({ action: "deleteBoardAssignee", assigneeId });
    if (res.ok) await reloadAssignees();
    return { ok: res.ok, error: res.error };
  };

  const reloadBoardsRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    reloadBoardsRef.current = tasks.reloadBoards;
  }, [tasks]);

  const visibleBoards = useMemo(() => {
    const query = boardSearch.trim().toLowerCase();
    if (!query) return tasks.boardSummaries;
    return tasks.boardSummaries.filter((board) => {
      if (board.name.toLowerCase().includes(query)) return true;
      return board.description.toLowerCase().includes(query);
    });
  }, [boardSearch, tasks.boardSummaries]);

  const createTicketForm = useMemo<TicketDetailsForm>(() => {
    const fallbackStatusId = tasks.board.columnOrder[0] ?? "";
    const statusId = tasks.board.columns[tasks.createForm.statusId]
      ? tasks.createForm.statusId
      : fallbackStatusId;

    return {
      id: "create-ticket",
      title: tasks.createForm.title,
      description: tasks.createForm.description,
      statusId,
      priority: tasks.createForm.priority,
      dueDate: tasks.createForm.dueDate,
      tagsText: tasks.createForm.tagsText,
      assigneeIds: tasks.createForm.assigneeIds,
      scheduledFor: tasks.createForm.scheduledFor,
      checklistDone: 0,
      checklistTotal: 0,
      comments: 0,
      attachments: 0,
    };
  }, [tasks.board.columnOrder, tasks.board.columns, tasks.createForm]);

  const openBoardWorkspace = (boardId: string) => {
    tasks.setActiveBoardId(boardId);
    setWorkspaceOpen(true);
    const next = new URLSearchParams(window.location.search);
    next.set("board", boardId);
    const query = next.toString();
    router.replace(query ? `/boards?${query}` : "/boards");
  };

  const closeBoardWorkspace = () => {
    setWorkspaceOpen(false);
    tasks.clearSearch();
    const next = new URLSearchParams(window.location.search);
    next.delete("board");
    const query = next.toString();
    router.replace(query ? `/boards?${query}` : "/boards");
  };

  // ── Delete board: show confirmation first ──────────────────────────────────
  const requestDeleteBoard = (boardId: string) => {
    const board = tasks.boardSummaries.find((b) => b.id === boardId);
    setDeleteBoardName(board?.name ?? "this board");
    setDeleteBoardId(boardId);
  };

  const confirmDeleteBoard = async () => {
    if (!deleteBoardId) return;
    const boardId = deleteBoardId;
    setDeleteBoardId(null);

    const deleted = await tasks.handleDeleteBoard(boardId);
    if (!deleted) return;

    if (boardParam === boardId) {
      setWorkspaceOpen(false);
      const next = new URLSearchParams(window.location.search);
      next.delete("board");
      const query = next.toString();
      router.replace(query ? `/boards?${query}` : "/boards");
    }
  };

  // ── Copy board: show confirmation first ───────────────────────────────────
  const requestCopyBoard = (boardId: string, openAfter = false) => {
    const board = tasks.boardSummaries.find((b) => b.id === boardId);
    setCopyBoardName(board?.name ?? "this board");
    setCopyBoardId(boardId);
    setCopyAndOpen(openAfter);
  };

  const confirmCopyBoard = async () => {
    if (!copyBoardId) return;
    const boardId = copyBoardId;
    const shouldOpen = copyAndOpen;
    setCopyBoardId(null);

    const copiedBoardId = await tasks.handleCopyBoard(boardId);
    if (!copiedBoardId || !shouldOpen) return;
    openBoardWorkspace(copiedBoardId);
  };

  useEffect(() => {
    if (!boardParam) {
      setWorkspaceOpen(false);
      return;
    }

    const targetBoard = tasks.boards.find((board) => board.id === boardParam);
    if (!targetBoard) {
      setWorkspaceOpen(false);
      return;
    }

    tasks.setActiveBoardId(boardParam);
    setWorkspaceOpen(true);
  }, [boardParam, tasks]);

  // Listen for mc:open-ticket events from the sidebar Live Activity
  // (no ?ticket= URL param — avoids re-opening modal on refresh)
  useEffect(() => {
    const handler = (e: Event) => {
      const { ticketId, boardId } = (e as CustomEvent<{ ticketId: string; boardId: string }>).detail;
      if (!ticketId || !boardId) return;
      // Ensure the right board is open first
      if (tasks.board.tickets[ticketId]) {
        tasks.openDetailsModal(ticketId);
      } else {
        // Board may not be loaded yet — open it then wait for next render
        tasks.setActiveBoardId(boardId);
        setWorkspaceOpen(true);
        // Slight delay to let board state settle before opening modal
        setTimeout(() => {
          tasks.openDetailsModal(ticketId);
        }, 200);
      }
    };
    window.addEventListener("mc:open-ticket", handler);
    return () => window.removeEventListener("mc:open-ticket", handler);
  }, [tasks]);

  useEffect(() => {
    if (!workspaceOpen || !tasks.activeBoardId) {
      setBoardActivity([]);
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;

    const loadInitial = async () => {
      setBoardActivityLoading(true);
      try {
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "listBoardActivity", boardId: tasks.activeBoardId, limit: 20 }),
        });
        const data = await response.json();
        if (!cancelled) {
          setBoardActivity(Array.isArray(data.rows) ? data.rows : []);
        }
      } catch (error) {
        console.error("Failed to load initial activity", error);
      } finally {
        if (!cancelled) setBoardActivityLoading(false);
      }
    };

    void loadInitial();

    const connect = () => {
      setBoardActivityLoading(true);
      eventSource = new EventSource("/api/events");

      eventSource.addEventListener("ticket_activity", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          const row = data.row;
          if (row?.board_id === tasks.activeBoardId) {
            setBoardActivity((prev) => [row, ...prev].slice(0, 20));
            reloadBoardsRef.current?.();
          }
        } catch {
          // ignore malformed events
        }
      });

      eventSource.addEventListener("error", () => {
        // EventSource will attempt to reconnect automatically.
      });

      eventSource.onopen = () => {
        setBoardActivityLoading(false);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  }, [tasks.activeBoardId, workspaceOpen]); // removed tasks from deps

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 14)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" initialUser={sidebarUser} />
      <SidebarInset>
        <header className="flex h-auto shrink-0 border-b transition-[width,height] ease-linear md:h-(--header-height) md:group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12">
          <div className="flex w-full flex-col gap-2 px-3 py-2 sm:px-4 lg:px-6 md:flex-row md:items-center md:gap-2 md:py-0">
            <div className="flex items-center gap-1">
              <SidebarTrigger className="-ml-1" />
              {workspaceOpen && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={closeBoardWorkspace}
                  aria-label="Back to all boards"
                  title="All boards"
                  className="size-7 rounded-full border border-border/60 bg-background/70 text-muted-foreground shadow-xs transition-[transform,box-shadow,background-color] hover:-translate-y-0.5 hover:bg-accent hover:text-foreground hover:shadow-sm"
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                </Button>
              )}
              <Separator orientation="vertical" className="mx-2 hidden h-4 md:flex" />
              <span className="max-w-[220px] truncate text-sm font-medium">
                {workspaceOpen ? tasks.activeBoardName || "Boards" : "Boards"}
              </span>
            </div>

            <div className="flex w-full items-center gap-2 md:flex-1 md:justify-center md:px-4">
              <div className="relative min-w-0 flex-1 md:max-w-sm">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-9 pl-9 pr-3 text-sm"
                  placeholder={workspaceOpen ? "Search tickets..." : "Search boards..."}
                  value={workspaceOpen ? tasks.searchInput : boardSearch}
                  onChange={(event) => {
                    if (workspaceOpen) {
                      tasks.setSearchInput(event.target.value);
                      return;
                    }
                    setBoardSearch(event.target.value);
                  }}
                />
              </div>

              {workspaceOpen ? (
                <div className="flex items-center gap-1 md:hidden">
                  <Button
                    size="icon-sm"
                    onClick={() => tasks.openCreateModal(tasks.board.columnOrder[0] ?? "")}
                    aria-label="Create ticket"
                  >
                    <PlusIcon className="h-4 w-4" />
                  </Button>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Board actions" id={`workspace-board-actions-${tasks.activeBoardId || 'none'}`}>
                        <MoreHorizontalIcon className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem onClick={tasks.openCreateListModal}>
                        Add list
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setManageAssigneesOpen(true)}>
                        Manage assignees
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => tasks.openEditBoardModal(tasks.activeBoardId)}>
                        Edit board
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => requestCopyBoard(tasks.activeBoardId, true)}>
                        Copy board
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => requestDeleteBoard(tasks.activeBoardId)}
                      >
                        Delete board
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup
                        value={tasks.sort}
                        onValueChange={(value) => tasks.setSort(value as SortMode)}
                      >
                        {SORT_OPTIONS.map((option) => (
                          <DropdownMenuRadioItem key={option.key} value={option.key}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup
                        value={tasks.view}
                        onValueChange={(value) => tasks.setView(value as ViewMode)}
                      >
                        {VIEW_OPTIONS.map((option) => (
                          <DropdownMenuRadioItem key={option.key} value={option.key}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={tasks.openCreateBoardModal} className="md:hidden">
                  <PlusIcon className="h-4 w-4" />
                  Add board
                </Button>
              )}
            </div>

            <div className="hidden items-center gap-2 md:flex">
              {workspaceOpen ? (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" id="workspace-board-dropdown-trigger">Board</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem onClick={() => tasks.openEditBoardModal(tasks.activeBoardId)}>
                        Edit board
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => requestCopyBoard(tasks.activeBoardId, true)}>
                        Copy board
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => requestDeleteBoard(tasks.activeBoardId)}
                      >
                        Delete board
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setManageAssigneesOpen(true)}
                    id="workspace-manage-assignees-trigger"
                  >
                    Assignees
                  </Button>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5" id="workspace-add-dropdown-trigger">
                        <PlusIcon className="h-4 w-4" />
                        Add
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem onClick={() => tasks.openCreateModal(tasks.board.columnOrder[0] ?? "")}>
                        Create ticket
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={tasks.openCreateListModal}>
                        Add list
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" id="workspace-filter-dropdown-trigger">
                        <SlidersHorizontalIcon className="h-3.5 w-3.5" />
                        Filter
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuRadioGroup
                        value={tasks.sort}
                        onValueChange={(value) => tasks.setSort(value as SortMode)}
                      >
                        {SORT_OPTIONS.map((option) => (
                          <DropdownMenuRadioItem key={option.key} value={option.key}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup
                        value={tasks.view}
                        onValueChange={(value) => tasks.setView(value as ViewMode)}
                      >
                        {VIEW_OPTIONS.map((option) => (
                          <DropdownMenuRadioItem key={option.key} value={option.key}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : (
                <Button variant="outline" size="sm" className="gap-1.5 cursor-pointer" onClick={tasks.openCreateBoardModal}>
                  <PlusIcon className="h-4 w-4" />
                  Add board
                </Button>
              )}
            </div>
          </div>
        </header>

        {!workspaceOpen ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-1 flex-col overflow-auto px-4 py-5 sm:px-5 lg:px-6"
          >
            <div className="mb-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground">All boards</h2>
                <span className="text-xs text-muted-foreground">
                  {tasks.boards.length} board{tasks.boards.length !== 1 ? "s" : ""}
                </span>
              </div>
              {!!boardSearch.trim() && (
                <span className="text-xs text-muted-foreground">
                  {visibleBoards.length} result{visibleBoards.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            {visibleBoards.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center border rounded-xl bg-muted/20">
                <LayoutGridIcon className="size-12 text-muted-foreground/40 mb-4" />
                <p className="font-semibold text-foreground mb-1">No boards found</p>
                <p className="text-sm text-muted-foreground max-w-xs">
                  Create your first board to organize and track your tasks visually.
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Board</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="w-20">Tickets</TableHead>
                      <TableHead className="w-20">Lists</TableHead>
                      <TableHead className="hidden lg:table-cell">Created</TableHead>
                      <TableHead className="hidden lg:table-cell">Updated</TableHead>
                      <TableHead className="hidden xl:table-cell">Last ticket</TableHead>
                      <TableHead className="w-24 text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleBoards.map((board) => (
                      <TableRow
                        key={board.id}
                        className={cn(
                          "cursor-pointer transition-colors hover:bg-muted/40",
                          board.id === tasks.activeBoardId && "bg-muted/20",
                        )}
                        onClick={() => openBoardWorkspace(board.id)}
                      >
                        <TableCell className="font-medium">
                          <span className="truncate">{board.name}</span>
                        </TableCell>
                        <TableCell className="max-w-[360px]">
                          <p className="truncate text-sm text-muted-foreground">
                            {board.description || "No description yet."}
                          </p>
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">{board.totalTickets}</TableCell>
                        <TableCell className="text-sm tabular-nums">{board.listCount}</TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                          {formatDateUTC(board.createdAt)}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                          {formatDateUTC(board.updatedAt)}
                        </TableCell>
                        <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">
                          {formatDateTimeUTC(board.lastTicketAt)}
                        </TableCell>
                        <TableCell>
                          <div
                            className="flex items-center justify-end gap-1"
                            onClick={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                          >
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="cursor-pointer"
                                  aria-label={`Actions for ${board.name}`}
                                  id={`board-actions-${board.id}`}
                                >
                                  <MoreHorizontalIcon className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => openBoardWorkspace(board.id)}>
                                  Open board
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => tasks.openEditBoardModal(board.id)}>
                                  Edit board
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => requestCopyBoard(board.id)}>
                                  Copy board
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => requestDeleteBoard(board.id)}
                                >
                                  Delete board
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="flex flex-1 flex-col overflow-hidden"
          >
            <div className="border-b px-3 py-2 sm:px-4 lg:px-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{tasks.activeBoardName}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {tasks.totalVisible} ticket{tasks.totalVisible !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <div className={`h-2 w-2 rounded-full ${boardActivityLoading ? "bg-amber-500" : "bg-emerald-500"}`} />
                  <span>{boardActivityLoading ? "Connecting…" : "Live feed"}</span>
                </div>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 gap-4 overflow-hidden px-3 py-4 sm:px-4 lg:grid-cols-[1fr_340px] lg:px-6">
              <div className="min-h-0 overflow-auto">
                <div className="pb-3" />

                <div className={cn("min-h-0 overflow-auto", tasks.view === "kanban" && "overflow-x-auto")}>
                  {tasks.view === "kanban" && (
                    <KanbanView
                      board={tasks.board}
                      assigneeById={tasks.assigneeById}
                      visibleTicketIdsByColumn={tasks.visibleTicketIdsByColumn}
                      onAddTask={tasks.openCreateModal}
                      canDeleteList={tasks.canDeleteList}
                      onDeleteList={tasks.handleDeleteList}
                      onTicketClick={tasks.openDetailsModal}
                      onTicketCopy={tasks.handleCopyTicket}
                      onTicketDelete={tasks.handleDeleteTicket}
                      moveColumn={tasks.moveColumn}
                      moveTicket={tasks.moveTicket}
                    />
                  )}
                  {tasks.view === "list" && (
                    <ListView
                      tickets={tasks.sortedFilteredTickets}
                      board={tasks.board}
                      assigneeById={tasks.assigneeById}
                      onTicketClick={tasks.openDetailsModal}
                      onTicketCopy={tasks.handleCopyTicket}
                      onTicketDelete={tasks.handleDeleteTicket}
                      searchQuery={tasks.searchQuery}
                      onClearSearch={tasks.clearSearch}
                    />
                  )}
                  {tasks.view === "grid" && (
                    <GridView
                      tickets={tasks.sortedFilteredTickets}
                      assigneeById={tasks.assigneeById}
                      searchQuery={tasks.searchQuery}
                      onTicketClick={tasks.openDetailsModal}
                      onTicketCopy={tasks.handleCopyTicket}
                      onTicketDelete={tasks.handleDeleteTicket}
                      onClearSearch={tasks.clearSearch}
                    />
                  )}
                </div>
              </div>

              <aside className="hidden min-h-0 overflow-hidden rounded-lg border border-border/60 bg-background/70 p-3 lg:flex lg:flex-col">
                <BoardActivityFeed
                  activity={boardActivity}
                  loading={boardActivityLoading}
                  onTicketClick={(ticketId) => {
                    tasks.openDetailsModal(ticketId);
                  }}
                />
              </aside>
            </div>
          </motion.div>
        )}
      </SidebarInset>

      <TicketDetailsModal
        mode="create"
        open={tasks.modal === "create"}
        form={createTicketForm}
        board={tasks.board}
        attachments={[]}
        attachmentsLoading={false}
        attachmentsUploading={false}
        subtasks={[]}
        subtasksLoading={false}
        onAddSubtask={() => {}}
        onToggleSubtask={() => {}}
        onDeleteSubtask={() => {}}
        onRenameChecklist={() => {}}
        onDeleteChecklist={() => {}}
        comments={[]}
        commentsLoading={false}
        commentDraft=""
        onCommentDraftChange={() => {}}
        onAddComment={() => {}}
        onDeleteComment={() => {}}
        activity={[]}
        activityLoading={false}
        onChange={(patch) =>
          tasks.setCreateForm((prev) => ({
            ...prev,
            title: patch.title ?? prev.title,
            description: patch.description ?? prev.description,
            statusId: patch.statusId ?? prev.statusId,
            priority: patch.priority ?? prev.priority,
            dueDate: patch.dueDate ?? prev.dueDate,
            scheduledFor: patch.scheduledFor ?? prev.scheduledFor,
            tagsText: patch.tagsText ?? prev.tagsText,
            assigneeIds: patch.assigneeIds ?? prev.assigneeIds,
          }))
        }
        onUploadAttachments={() => {}}
        onDeleteAttachment={() => {}}
        onSave={(files, draftSubtasks) => void tasks.handleCreateTicket(files ?? [], draftSubtasks ?? [])}
        onCopy={() => {}}
        onDelete={() => {}}
        onClose={tasks.closeCreateModal}
      />

      <CreateBoardModal
        open={tasks.createBoardOpen}
        mode="create"
        title={tasks.createBoardTitle}
        description={tasks.createBoardDescription}
        error={tasks.createBoardError}
        onTitleChange={tasks.setCreateBoardTitle}
        onDescriptionChange={tasks.setCreateBoardDescription}
        onSubmit={tasks.handleCreateBoard}
        onClose={tasks.closeCreateBoardModal}
      />

      <CreateBoardModal
        open={tasks.editBoardOpen}
        mode="edit"
        title={tasks.editBoardTitle}
        description={tasks.editBoardDescription}
        error={tasks.editBoardError}
        onTitleChange={tasks.setEditBoardTitle}
        onDescriptionChange={tasks.setEditBoardDescription}
        onSubmit={tasks.handleUpdateBoard}
        onClose={tasks.closeEditBoardModal}
      />

      <CreateListModal
        open={tasks.createListOpen}
        title={tasks.createListTitle}
        error={tasks.createListError}
        onTitleChange={tasks.setCreateListTitle}
        onSubmit={tasks.handleCreateList}
        onClose={tasks.closeCreateListModal}
      />

      <ManageAssigneesModal
        open={manageAssigneesOpen}
        boardName={tasks.activeBoardName || "this board"}
        assignees={assigneesByBoardId[tasks.activeBoardId] ?? []}
        onCreate={handleCreateAssignee}
        onUpdate={handleUpdateAssignee}
        onDelete={handleDeleteAssignee}
        onClose={() => setManageAssigneesOpen(false)}
      />

      {tasks.detailsForm &&
        (() => {
          const detailsForm = tasks.detailsForm;
          return (
            <TicketDetailsModal
              open={tasks.modal === "details"}
              form={detailsForm}
              board={tasks.board}
              attachments={tasks.detailsAttachments}
              attachmentsLoading={tasks.detailsAttachmentsLoading}
              attachmentsUploading={tasks.detailsAttachmentsUploading}
              subtasks={tasks.detailsSubtasks}
              subtasksLoading={tasks.detailsSubtasksLoading}
              onAddSubtask={(title, checklistName) => void tasks.addDetailsSubtask(checklistName, title)}
              onToggleSubtask={(subtaskId, completed) =>
                void tasks.toggleDetailsSubtask(subtaskId, completed)
              }
              onDeleteSubtask={(subtaskId) => void tasks.deleteDetailsSubtask(subtaskId)}
              onRenameChecklist={(oldName, newName) => void tasks.renameDetailsChecklist(oldName, newName)}
              onDeleteChecklist={(name) => void tasks.deleteDetailsChecklist(name)}
              comments={tasks.detailsComments}
              commentsLoading={tasks.detailsCommentsLoading}
              commentDraft={tasks.commentDraft}
              onCommentDraftChange={tasks.setCommentDraft}
              onAddComment={() => void tasks.addDetailsComment()}
              onDeleteComment={(commentId) => void tasks.deleteDetailsComment(commentId)}
              activity={tasks.detailsActivity}
              activityLoading={tasks.detailsActivityLoading}
              onChange={(patch) =>
                tasks.setDetailsForm((prev) => (prev ? { ...prev, ...patch } : prev))
              }
              onUploadAttachments={(files) => void tasks.uploadDetailsAttachments(files)}
              onDeleteAttachment={(attachmentId) => void tasks.deleteDetailsAttachment(attachmentId)}
              onSave={() => tasks.handleSaveDetails()}
              onCopy={() => void tasks.handleCopyTicket(detailsForm.id)}
              onDelete={() => void tasks.handleDeleteTicket(detailsForm.id)}
              onClose={tasks.closeDetailsModal}
            />
          );
        })()}

      <DiscardModal
        open={tasks.modal === "discard"}
        onKeepEditing={tasks.keepEditing}
        onDiscard={tasks.discardChanges}
      />

      {/* Delete board confirmation */}
      <AlertDialog open={!!deleteBoardId} onOpenChange={(open) => { if (!open) setDeleteBoardId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2Icon className="size-5 text-destructive" />
              Delete board
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <span className="font-semibold text-foreground">{deleteBoardName}</span>? All tickets, lists, and activity in this board will be permanently removed. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void confirmDeleteBoard()}
            >
              Delete board
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Copy board confirmation */}
      <AlertDialog open={!!copyBoardId} onOpenChange={(open) => { if (!open) setCopyBoardId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CopyIcon className="size-5 text-primary" />
              Copy board
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will create a duplicate of <span className="font-semibold text-foreground">{copyBoardName}</span> including all lists and tickets. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmCopyBoard()}>
              Copy board
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </SidebarProvider>
  );
}

