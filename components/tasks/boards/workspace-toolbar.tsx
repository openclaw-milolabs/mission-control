"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDownIcon,
  ColumnsIcon,
  CopyIcon,
  FilterIcon,
  ListChecksIcon,
  ListIcon,
  PlusIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  TagIcon,
  Trash2Icon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import type { Assignee, Label, SortMode, ViewMode } from "@/types/tasks";

type DueFilter = "all" | "overdue" | "today" | "thisWeek" | "noDue";

type ToolbarTasks = {
  activeBoardId: string;
  board: { columnOrder: string[] };
  sort: SortMode;
  setSort: (v: SortMode) => void;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  openCreateModal: (statusId: string) => void;
  openCreateListModal: () => void;
  assigneeFilter: Set<string>;
  toggleAssigneeFilter: (id: string) => void;
  clearAssigneeFilter: () => void;
  labelFilter: Set<string>;
  toggleLabelFilter: (id: string) => void;
  clearLabelFilter: () => void;
  dueFilter: DueFilter;
  setDueFilter: (v: DueFilter) => void;
};

type Props = {
  tasks: ToolbarTasks;
  boardAssignees: Assignee[];
  boardLabels: Label[];
  onManageAssignees: () => void;
  onManageLabels: () => void;
  onEditBoard: () => void;
  onCopyBoard: () => void;
  onDeleteBoard: () => void;
};

const SORT_LABELS: Record<SortMode, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  dueDate: "Due date",
  title: "Title (A→Z)",
};

const VIEW_LABELS: Record<ViewMode, string> = {
  kanban: "Kanban",
  list: "List",
  grid: "Grid",
  calendar: "Calendar",
};

const DUE_LABELS: Record<DueFilter, string> = {
  all: "All",
  overdue: "Overdue",
  today: "Today",
  thisWeek: "This week",
  noDue: "No due date",
};

export function WorkspaceToolbar({
  tasks,
  boardAssignees,
  boardLabels,
  onManageAssignees,
  onManageLabels,
  onEditBoard,
  onCopyBoard,
  onDeleteBoard,
}: Props) {
  const activeFilterCount =
    tasks.assigneeFilter.size + tasks.labelFilter.size + (tasks.dueFilter !== "all" ? 1 : 0);
  const clearAllFilters = () => {
    tasks.clearAssigneeFilter();
    tasks.clearLabelFilter();
    tasks.setDueFilter("all");
  };

  return (
    <>
      {/* Primary CTA — the most common action stays a visible button */}
      <Button
        size="sm"
        className="gap-1.5"
        onClick={() => tasks.openCreateModal(tasks.board.columnOrder[0] ?? "")}
        id="workspace-add-ticket-trigger"
      >
        <PlusIcon className="h-4 w-4" />
        Add ticket
      </Button>

      {/* Board ▾ — everything that mutates this board */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" id="workspace-board-dropdown-trigger">
            <SettingsIcon className="size-3.5" />
            Board
            <ChevronDownIcon className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            On this board
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={tasks.openCreateListModal}>
            <ColumnsIcon className="size-3.5 text-muted-foreground" />
            Add list
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onManageAssignees}>
            <UserPlusIcon className="size-3.5 text-muted-foreground" />
            Manage assignees
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onManageLabels}>
            <TagIcon className="size-3.5 text-muted-foreground" />
            Manage labels
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuLabel className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Board settings
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={onEditBoard}>
            <SettingsIcon className="size-3.5 text-muted-foreground" />
            Edit board
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCopyBoard}>
            <CopyIcon className="size-3.5 text-muted-foreground" />
            Copy board
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDeleteBoard}>
            <Trash2Icon className="size-3.5" />
            Delete board
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* View ▾ — affects what I'm currently looking at */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={activeFilterCount > 0 ? "outline" : "ghost"}
            size="sm"
            className="gap-1.5"
            id="workspace-view-dropdown-trigger"
          >
            <SlidersHorizontalIcon className="size-3.5" />
            View
            {activeFilterCount > 0 && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-medium tabular-nums">
                {activeFilterCount}
              </span>
            )}
            <ChevronDownIcon className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {/* Filters section */}
          <div className="flex items-center justify-between px-2 pt-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Filters
            </span>
            {activeFilterCount > 0 && (
              <button
                onClick={clearAllFilters}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                Clear all
              </button>
            )}
          </div>

          {/* Assignee filter — submenu */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <UsersIcon className="size-3.5 text-muted-foreground" />
              <span className="flex-1">Assignee</span>
              {tasks.assigneeFilter.size > 0 && (
                <span className="rounded-full bg-foreground/10 px-1.5 text-[9px] font-medium tabular-nums">
                  {tasks.assigneeFilter.size}
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuLabel className="text-xs">Filter by assignee</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {boardAssignees.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No assignees on this board.</p>
              ) : (
                <>
                  <DropdownMenuCheckboxItem
                    checked={tasks.assigneeFilter.has("__unassigned__")}
                    onCheckedChange={() => tasks.toggleAssigneeFilter("__unassigned__")}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className="text-muted-foreground italic">Unassigned</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  {boardAssignees.map((a) => (
                    <DropdownMenuCheckboxItem
                      key={a.id}
                      checked={tasks.assigneeFilter.has(a.id)}
                      onCheckedChange={() => tasks.toggleAssigneeFilter(a.id)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="flex size-4 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                          style={{ backgroundColor: a.color }}
                        >
                          {a.initials}
                        </span>
                        <span className="truncate">{a.name}</span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                  {tasks.assigneeFilter.size > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => tasks.clearAssigneeFilter()}
                        className="text-xs text-muted-foreground"
                      >
                        Clear
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Label filter — submenu */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <TagIcon className="size-3.5 text-muted-foreground" />
              <span className="flex-1">Label</span>
              {tasks.labelFilter.size > 0 && (
                <span className="rounded-full bg-foreground/10 px-1.5 text-[9px] font-medium tabular-nums">
                  {tasks.labelFilter.size}
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuLabel className="text-xs">Filter by label</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {boardLabels.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No labels on this board.</p>
              ) : (
                <>
                  <DropdownMenuCheckboxItem
                    checked={tasks.labelFilter.has("__unlabeled__")}
                    onCheckedChange={() => tasks.toggleLabelFilter("__unlabeled__")}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className="text-muted-foreground italic">Unlabeled</span>
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  {boardLabels.map((l) => (
                    <DropdownMenuCheckboxItem
                      key={l.id}
                      checked={tasks.labelFilter.has(l.id)}
                      onCheckedChange={() => tasks.toggleLabelFilter(l.id)}
                      onSelect={(e) => e.preventDefault()}
                    >
                      <span
                        className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white"
                        style={{ backgroundColor: l.color }}
                      >
                        {l.name}
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                  {tasks.labelFilter.size > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => tasks.clearLabelFilter()}
                        className="text-xs text-muted-foreground"
                      >
                        Clear
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Due filter — submenu (radio) */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <FilterIcon className="size-3.5 text-muted-foreground" />
              <span className="flex-1">Due date</span>
              {tasks.dueFilter !== "all" && (
                <span className="rounded-full bg-foreground/10 px-1.5 text-[9px] font-medium">
                  {DUE_LABELS[tasks.dueFilter]}
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-48">
              <DropdownMenuLabel className="text-xs">Filter by due date</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={tasks.dueFilter}
                onValueChange={(v) => tasks.setDueFilter(v as DueFilter)}
              >
                <DropdownMenuRadioItem value="all">All</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="overdue">Overdue</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="today">Today</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="thisWeek">This week</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="noDue">No due date</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {/* Sort section */}
          <DropdownMenuLabel className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <ListChecksIcon className="size-3" />
            Sort by
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={tasks.sort}
            onValueChange={(v) => tasks.setSort(v as SortMode)}
          >
            {(["newest", "oldest", "dueDate", "title"] as SortMode[]).map((key) => (
              <DropdownMenuRadioItem key={key} value={key}>
                {SORT_LABELS[key]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />

          {/* View mode */}
          <DropdownMenuLabel className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <ListIcon className="size-3" />
            View as
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={tasks.view}
            onValueChange={(v) => tasks.setView(v as ViewMode)}
          >
            {(["kanban", "list", "grid", "calendar"] as ViewMode[]).map((key) => (
              <DropdownMenuRadioItem key={key} value={key}>
                {VIEW_LABELS[key]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
