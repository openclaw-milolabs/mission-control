"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { Assignee, Label, Ticket } from "@/types/tasks";
import { cn } from "@/lib/utils";

type Props = {
  tickets: Ticket[];
  assigneeById: Record<string, Assignee>;
  labelById?: Record<string, Label>;
  onTicketClick: (ticketId: string) => void;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1);
}
function endOfMonth(year: number, month: number): Date {
  return new Date(year, month + 1, 0);
}

function priorityDotClass(p: Ticket["priority"]): string {
  switch (p) {
    case "urgent": return "bg-rose-600";
    case "high": return "bg-orange-500";
    case "medium": return "bg-amber-500";
    default: return "bg-emerald-500";
  }
}

export function CalendarView({ tickets, labelById, onTicketClick }: Props) {
  const today = useMemo(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), t.getDate());
  }, []);
  const [cursor, setCursor] = useState<Date>(today);

  const { year, month } = useMemo(() => ({ year: cursor.getFullYear(), month: cursor.getMonth() }), [cursor]);

  const ticketsByDay = useMemo(() => {
    const out: Record<string, Ticket[]> = {};
    for (const t of tickets) {
      if (!t.dueDate) continue;
      if (!out[t.dueDate]) out[t.dueDate] = [];
      out[t.dueDate].push(t);
    }
    return out;
  }, [tickets]);

  // Build a 6-row grid (42 days) starting at the Monday on or before the first day of the month.
  const cells = useMemo(() => {
    const first = startOfMonth(year, month);
    const dayOfWeek = (first.getDay() + 6) % 7; // 0=Mon
    const start = new Date(year, month, 1 - dayOfWeek);
    const arr: Date[] = [];
    for (let i = 0; i < 42; i += 1) {
      arr.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    }
    return arr;
  }, [year, month]);

  const monthLabel = useMemo(
    () => new Date(year, month, 1).toLocaleString(undefined, { month: "long", year: "numeric" }),
    [year, month],
  );

  const goPrev = () => setCursor(new Date(year, month - 1, 1));
  const goNext = () => setCursor(new Date(year, month + 1, 1));
  const goToday = () => setCursor(today);

  const todayKey = dateKey(today);

  return (
    <div className="flex h-full flex-col">
      {/* Month header */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{monthLabel}</h3>
          <span className="text-xs text-muted-foreground tabular-nums">
            {Object.values(ticketsByDay).reduce((acc, ts) => acc + ts.length, 0)} dated tickets
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={goPrev} aria-label="Previous month">
            <ChevronLeftIcon className="size-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={goToday}>
            Today
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={goNext} aria-label="Next month">
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      </div>

      {/* Weekday strip */}
      <div className="grid grid-cols-7 border-b text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-center">{d}</div>
        ))}
      </div>

      {/* Days grid */}
      <div className="grid flex-1 grid-cols-7 grid-rows-6 overflow-auto">
        {cells.map((d) => {
          const key = dateKey(d);
          const inMonth = d.getMonth() === month;
          const isToday = key === todayKey;
          const dayTickets = ticketsByDay[key] ?? [];
          return (
            <div
              key={key}
              className={cn(
                "flex min-h-[88px] flex-col gap-1 border-b border-r p-1.5",
                !inMonth && "bg-muted/20 text-muted-foreground/60",
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "inline-flex size-5 items-center justify-center rounded-full text-[10px] font-medium tabular-nums",
                    isToday && "bg-foreground text-background",
                  )}
                >
                  {d.getDate()}
                </span>
                {dayTickets.length > 3 && (
                  <span className="text-[9px] text-muted-foreground tabular-nums">{dayTickets.length}</span>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-0.5 overflow-hidden">
                {dayTickets.slice(0, 3).map((t) => {
                  const firstLabel = (t.labelIds ?? []).map((id) => labelById?.[id]).find(Boolean);
                  const swatch = firstLabel?.color;
                  return (
                    <button
                      key={t.id}
                      onClick={() => onTicketClick(t.id)}
                      className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[10px] transition-colors hover:bg-accent"
                      title={t.title}
                    >
                      <span
                        className={cn("size-1.5 shrink-0 rounded-full", !swatch && priorityDotClass(t.priority))}
                        style={swatch ? { backgroundColor: swatch } : undefined}
                      />
                      <span className="truncate">{t.title}</span>
                    </button>
                  );
                })}
                {dayTickets.length > 3 && (
                  <button
                    onClick={() => onTicketClick(dayTickets[3].id)}
                    className="px-1 text-left text-[9px] text-muted-foreground hover:text-foreground"
                  >
                    +{dayTickets.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
