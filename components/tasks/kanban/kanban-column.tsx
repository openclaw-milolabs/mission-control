"use client";

import { useSortable, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { type Assignee, type Column, type Ticket, toneColor } from "@/types/tasks";
import { TicketCard } from "../shared/ticket-card";

type Props = {
  column: Column;
  tickets: Ticket[];
  allTicketIds: string[];
  totalVisible?: number;
  hiddenCount?: number;
  isExpanded?: boolean;
  onShowMore?: () => void;
  onCollapse?: () => void;
  assigneeById: Record<string, Assignee>;
  isActive?: boolean;
  onAddTask: () => void;
  canDeleteList: boolean;
  onDeleteList: () => void;
  onTicketClick: (ticketId: string) => void;
  onTicketCopy: (ticketId: string) => void;
  onTicketDelete: (ticketId: string) => void;
};

const columnToneClass: Record<Column["tone"], string> = {
  neutral: "border-slate-300/70 bg-slate-100/60 dark:border-slate-800 dark:bg-slate-950/30",
  info: "border-blue-300/60 bg-blue-50/70 dark:border-blue-900/50 dark:bg-blue-950/20",
  warning: "border-amber-300/60 bg-amber-50/70 dark:border-amber-900/40 dark:bg-amber-950/20",
  success: "border-emerald-300/60 bg-emerald-50/70 dark:border-emerald-900/40 dark:bg-emerald-950/20",
};

const columnHeaderToneClass: Record<Column["tone"], string> = {
  neutral: "bg-slate-100/80 dark:bg-slate-900/40",
  info: "bg-blue-100/70 dark:bg-blue-900/30",
  warning: "bg-amber-100/70 dark:bg-amber-900/30",
  success: "bg-emerald-100/70 dark:bg-emerald-900/30",
};

export function KanbanColumn({
  column,
  tickets,
  allTicketIds,
  totalVisible,
  hiddenCount = 0,
  isExpanded = false,
  onShowMore,
  onCollapse,
  assigneeById,
  isActive,
  onAddTask,
  canDeleteList,
  onDeleteList,
  onTicketClick,
  onTicketCopy,
  onTicketDelete,
}: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isOver,
    isDragging: isColumnDragging,
  } = useSortable({ id: column.id, data: { type: "column" } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex flex-col w-72 shrink-0 rounded-xl border overflow-hidden",
        columnToneClass[column.tone],
        isActive && "ring-2 ring-primary/20",
        isColumnDragging && "opacity-40 shadow-2xl",
        isOver && !isColumnDragging && "ring-2 ring-primary/30",
      )}
    >
      {/* Header — drag handle for column */}
      <div
        {...attributes}
        {...listeners}
        className={cn(
          "flex items-center gap-2 px-3 py-2.5 cursor-grab active:cursor-grabbing select-none border-b",
          columnHeaderToneClass[column.tone],
        )}
      >
        <span className={cn("h-2 w-2 rounded-full shrink-0", toneColor[column.tone])} />
        <span className="flex-1 text-sm font-semibold text-foreground truncate">{column.title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {totalVisible !== undefined && totalVisible !== tickets.length
            ? `${tickets.length} / ${totalVisible}`
            : tickets.length}
        </span>
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <KebabIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onAddTask}>Add task</DropdownMenuItem>
              {canDeleteList ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={onDeleteList}>
                    Delete list
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Body */}
      <ScrollArea className="flex-1 min-h-0">
        <SortableContext items={allTicketIds} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2 p-2 min-h-16">
            {tickets.length === 0 ? (
              <div className={cn(
                "flex items-center justify-center h-16 rounded-lg border-2 border-dashed text-xs text-muted-foreground",
                isOver && "border-primary/50 bg-primary/5",
              )}>
                Drop here
              </div>
            ) : (
              tickets.map((ticket) => (
                <SortableTicket
                  key={ticket.id}
                  ticket={ticket}
                  assigneeById={assigneeById}
                  onClick={() => onTicketClick(ticket.id)}
                  onCopy={() => onTicketCopy(ticket.id)}
                  onDelete={() => onTicketDelete(ticket.id)}
                />
              ))
            )}
          </div>
        </SortableContext>
      </ScrollArea>

      {/* Pagination footer */}
      {hiddenCount > 0 && onShowMore && (
        <div className="px-2 pt-1.5">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-center text-xs h-7"
            onClick={onShowMore}
          >
            Show {hiddenCount} more
          </Button>
        </div>
      )}
      {isExpanded && onCollapse && (
        <div className="px-2 pt-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center text-muted-foreground text-xs h-7"
            onClick={onCollapse}
          >
            Show less
          </Button>
        </div>
      )}

      {/* Footer */}
      <div className="p-2 border-t">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground text-xs h-8"
          onClick={onAddTask}
        >
          <PlusIcon className="w-3.5 h-3.5 mr-1" />
          Add task
        </Button>
      </div>
    </div>
  );
}

function SortableTicket({
  ticket,
  assigneeById,
  onClick,
  onCopy,
  onDelete,
}: {
  ticket: Ticket;
  assigneeById: Record<string, Assignee>;
  onClick: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ticket.id, data: { type: "ticket", columnId: ticket.statusId } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cn(isDragging && "opacity-0")}
    >
      <TicketCard
        ticket={ticket}
        assigneeById={assigneeById}
        onClick={onClick}
        onCopy={onCopy}
        onDelete={onDelete}
        isDragging={isDragging}
      />
    </div>
  );
}

function KebabIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
