"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Assignee, type Label, type Ticket, formatDue } from "@/types/tasks";
import { cn } from "@/lib/utils";

type Props = {
  ticket: Ticket;
  assigneeById: Record<string, Assignee>;
  labelById?: Record<string, Label>;
  onClick: () => void;
  onCopy?: () => void;
  onDelete?: () => void;
  dense?: boolean;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
  isDragging?: boolean;
};

const priorityConfig: Record<Ticket["priority"], { dot: string; label: string; bar: string }> = {
  low:    { dot: "bg-emerald-500", label: "text-emerald-600 dark:text-emerald-400", bar: "bg-emerald-500" },
  medium: { dot: "bg-amber-500",   label: "text-amber-600 dark:text-amber-400",   bar: "bg-amber-500"   },
  high:   { dot: "bg-orange-500",  label: "text-orange-600 dark:text-orange-400",  bar: "bg-orange-500"  },
  urgent: { dot: "bg-rose-600",    label: "text-rose-600 dark:text-rose-400",      bar: "bg-rose-600"    },
};

const priorityBorderAccent: Record<Ticket["priority"], string> = {
  low:    "border-l-emerald-500/50",
  medium: "border-l-amber-500/50",
  high:   "border-l-orange-500/50",
  urgent: "border-l-rose-600/70",
};

const priorityLabel = (p: Ticket["priority"]) => p.charAt(0).toUpperCase() + p.slice(1);

export function TicketCard({
  ticket,
  assigneeById,
  labelById,
  onClick,
  onCopy,
  onDelete,
  dense,
  dragHandleProps,
  isDragging,
}: Props) {
  const ticketLabels = (ticket.labelIds ?? [])
    .map((id) => labelById?.[id])
    .filter(Boolean) as Label[];
  const visibleAssignees = ticket.assigneeIds.slice(0, 3);
  const extra = ticket.assigneeIds.length - visibleAssignees.length;
  const shortDesc = ticket.description?.trim().replace(/\s+/g, " ") ?? "";
  const descPreview = shortDesc.length > 90 ? `${shortDesc.slice(0, 90)}…` : shortDesc;
  const cfg = priorityConfig[ticket.priority] ?? priorityConfig.low;
  const hasMeta = ticket.dueDate || ticket.checklistTotal > 0 || ticket.comments > 0 || ticket.attachments > 0;

  return (
    <Card
      className={cn(
        "group cursor-pointer select-none border-border/60 bg-card py-0",
        "border-l-[3px]",
        priorityBorderAccent[ticket.priority],
        "transition-[transform,box-shadow,opacity] duration-150",
        "hover:-translate-y-0.5 hover:shadow-md hover:border-border",
        isDragging && "opacity-40 shadow-2xl rotate-1",
      )}
      onClick={onClick}
      {...dragHandleProps}
    >
      <CardContent className={cn("flex flex-col gap-2", dense ? "p-2.5" : "p-3.5")}>
        {/* Label chips strip */}
        {ticketLabels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {ticketLabels.slice(0, 4).map((l) => (
              <span
                key={l.id}
                className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium text-white"
                style={{ backgroundColor: l.color }}
                title={l.name}
              >
                {l.name}
              </span>
            ))}
            {ticketLabels.length > 4 && (
              <span className="text-[9px] text-muted-foreground/60">+{ticketLabels.length - 4}</span>
            )}
          </div>
        )}
        {/* Top row: priority pill + tags + kebab */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-1">
            {/* Priority dot + label */}
            <span className={cn("flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide", cfg.label)}>
              <span className={cn("size-1.5 rounded-full shrink-0", cfg.dot)} />
              {priorityLabel(ticket.priority)}
            </span>
            {/* Tags */}
            {ticket.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant="secondary" className="h-4 px-1.5 py-0 text-[10px] font-normal rounded-full">
                {tag}
              </Badge>
            ))}
            {ticket.tags.length > 2 && (
              <span className="text-[10px] text-muted-foreground/60">+{ticket.tags.length - 2}</span>
            )}
          </div>

          <div
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className="shrink-0"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 opacity-0 group-hover:opacity-70 hover:!opacity-100 transition-opacity"
                  aria-label="Ticket actions"
                >
                  <KebabIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onClick}>Open</DropdownMenuItem>
                {onCopy && <DropdownMenuItem onClick={onCopy}>Copy ticket</DropdownMenuItem>}
                {onDelete && (
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Title */}
        <p className="text-sm font-semibold leading-snug line-clamp-2 text-foreground/90">
          {ticket.title}
        </p>

        {/* Description preview */}
        {!dense && descPreview && (
          <p className="text-xs leading-relaxed text-muted-foreground/70 line-clamp-2">
            {descPreview}
          </p>
        )}

        {/* Footer: assignees + meta */}
        {(visibleAssignees.length > 0 || hasMeta) && (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            {/* Assignee avatars */}
            <div className="flex items-center -space-x-1.5">
              {visibleAssignees.map((id) => {
                const a = assigneeById[id];
                if (!a) return null;
                return (
                  <Avatar key={id} className="h-5 w-5 border-2 border-card text-[10px]">
                    <AvatarFallback style={{ backgroundColor: a.color }} className="text-white text-[9px]">
                      {a.initials}
                    </AvatarFallback>
                  </Avatar>
                );
              })}
              {extra > 0 && (
                <Avatar className="h-5 w-5 border-2 border-card">
                  <AvatarFallback className="text-[9px] bg-muted text-muted-foreground">+{extra}</AvatarFallback>
                </Avatar>
              )}
            </div>

            {/* Meta icons */}
            <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground/60">
              {ticket.dueDate && (
                <span className="flex items-center gap-0.5">
                  <CalendarIcon className="w-3 h-3" />
                  {formatDue(ticket.dueDate)}
                </span>
              )}
              {ticket.checklistTotal > 0 && (
                <span className={cn(
                  "flex items-center gap-0.5",
                  ticket.checklistDone === ticket.checklistTotal && "text-emerald-500",
                )}>
                  <CheckIcon className="w-3 h-3" />
                  {ticket.checklistDone}/{ticket.checklistTotal}
                </span>
              )}
              {ticket.comments > 0 && (
                <span className="flex items-center gap-0.5">
                  <CommentIcon className="w-3 h-3" />
                  {ticket.comments}
                </span>
              )}
              {ticket.attachments > 0 && (
                <span className="flex items-center gap-0.5">
                  <PaperclipIcon className="w-3 h-3" />
                  {ticket.attachments}
                </span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
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

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function CommentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
