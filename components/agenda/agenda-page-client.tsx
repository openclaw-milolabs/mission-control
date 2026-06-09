"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  format,
  startOfMonth, endOfMonth,
  startOfWeek, endOfWeek,
  startOfDay, endOfDay,
} from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { AgendaDetailsSheet, type AgendaEventSummary } from "@/components/agenda/agenda-details-sheet";
import { CustomMonthAgenda, type AgendaCalendarEvent, type ViewMode } from "@/components/agenda/custom-month-agenda";
import { AgendaFailedDialog } from "@/components/agenda/agenda-failed-bucket";
import { useAgenda } from "@/hooks/use-agenda";
import { toast } from "sonner";

type Props = {
  onEditEvent?: (event: AgendaEventSummary) => void;
  onCopyEvent?: (event: AgendaEventSummary) => void;
  onDeleteEvent?: (eventId: string) => void;
  onAddEvent?: () => void;
  onDayClick?: (date: Date) => void;
  onEventDrop?: (eventId: string, newDate: string, newTime?: string, sourceDate?: string) => void;
  agentsForDetails?: { id: string; name: string }[];
  headerActions?: React.ReactNode;
  onInitialReady?: () => void;
};

export function AgendaPageClient({ onEditEvent, onCopyEvent, onDeleteEvent, onAddEvent, onDayClick, onEventDrop, agentsForDetails, headerActions, onInitialReady }: Props) {
  const { calendarEvents, loading, loadEvents } = useAgenda();
  const searchParams = useSearchParams();
  const [detailsSheetOpen, setDetailsSheetOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<AgendaEventSummary | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [failedCount, setFailedCount] = useState(0);
  const [failedDialogOpen, setFailedDialogOpen] = useState(false);
  const initialReadySentRef = useRef(false);

  // Compute the visible date range based on view mode
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (viewMode === "month") {
      // Month grid shows from start-of-week of month start to end-of-week of month end
      const ms = startOfMonth(currentDate);
      const me = endOfMonth(currentDate);
      return {
        rangeStart: format(startOfWeek(ms, { weekStartsOn: 1 }), "yyyy-MM-dd"),
        rangeEnd: format(endOfWeek(me, { weekStartsOn: 1 }), "yyyy-MM-dd"),
      };
    }
    if (viewMode === "week") {
      const ws = startOfWeek(currentDate, { weekStartsOn: 1 });
      const we = endOfWeek(currentDate, { weekStartsOn: 1 });
      // Add ±1 day buffer (same as month view) to handle timezone edge cases
      // e.g. event at 23:04 CET on Mar 29 = 22:04 UTC on Mar 29, which might land
      // just outside the raw week range in UTC terms
      const bufferedWs = new Date(ws.getTime() - 86_400_000);
      const bufferedWe = new Date(we.getTime() + 86_400_000);
      return {
        rangeStart: format(bufferedWs, "yyyy-MM-dd"),
        rangeEnd: format(bufferedWe, "yyyy-MM-dd"),
      };
    }
    // day view — add ±1 day buffer for timezone safety (same as month/week)
    const dayStart = startOfDay(currentDate);
    const dayEnd = endOfDay(currentDate);
    const bufferedDayStart = new Date(dayStart.getTime() - 86_400_000);
    const bufferedDayEnd = new Date(dayEnd.getTime() + 86_400_000);
    return {
      rangeStart: format(bufferedDayStart, "yyyy-MM-dd"),
      rangeEnd: format(bufferedDayEnd, "yyyy-MM-dd"),
    };
  }, [currentDate, viewMode]);

  // Re-fetch when visible range changes
  useEffect(() => {
    void loadEvents(rangeStart, rangeEnd);
  }, [rangeStart, rangeEnd, loadEvents]);

  // Range ref so other dispatches (agenda-refresh) can use the current visible range
  const rangeRef = useRef({ rangeStart, rangeEnd });
  useEffect(() => { rangeRef.current = { rangeStart, rangeEnd }; }, [rangeStart, rangeEnd]);

  // Check failed count (used by agenda-refresh and SSE)
  const checkFailed = useCallback(async () => {
    try {
      const res = await fetch("/api/agenda/failed", { cache: "reload" });
      const json = await res.json();
      if (json.ok) setFailedCount((json.occurrences ?? []).length);
    } catch { /* ignore */ }
  }, []);

  // External refresh events (after create/edit/delete) — always use current visible range
  useEffect(() => {
    const handler = () => {
      const { rangeStart: rs, rangeEnd: re } = rangeRef.current;
      void loadEvents(rs, re);
      void checkFailed();
      document.dispatchEvent(new Event("agenda-stats-refresh"));
    };
    document.addEventListener("agenda-refresh", handler);
    return () => document.removeEventListener("agenda-refresh", handler);
  }, [loadEvents, checkFailed]);

  // ── SSE: live updates via PostgreSQL LISTEN/NOTIFY ──────────────────────────
  const sseRef = useRef<EventSource | null>(null);
  const sseStartedRef = useRef(false);
  const sseReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFetchingRef = useRef(false);

  useEffect(() => {
    if (sseStartedRef.current) return;
    sseStartedRef.current = true;

    // Initial failed count fetch
    void checkFailed();

    const connect = () => {
      const es = new EventSource("/api/agenda/events/stream");
      sseRef.current = es;

      es.addEventListener("agenda_change", async () => {
        if (isFetchingRef.current || !sseStartedRef.current) return;
        isFetchingRef.current = true;
        try {
          // Use current visible range so the calendar stays stable during refetch
          const { rangeStart, rangeEnd } = rangeRef.current;
          await loadEvents(rangeStart, rangeEnd);
        } catch { /* ignore */ } finally {
          isFetchingRef.current = false;
          void checkFailed();
          document.dispatchEvent(new Event("agenda-stats-refresh"));
        }
      });

      es.onerror = () => {
        if (sseReconnectTimer.current) clearTimeout(sseReconnectTimer.current);
        es.close();
        sseRef.current = null;
        sseReconnectTimer.current = setTimeout(() => {
          if (sseStartedRef.current) connect();
        }, 5_000);
      };
    };

    connect();

    return () => {
      sseStartedRef.current = false;
      if (sseReconnectTimer.current) clearTimeout(sseReconnectTimer.current);
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    };
  }, [loadEvents, checkFailed]);

  useEffect(() => {
    if (initialReadySentRef.current) return;
    if (loading) return;
    initialReadySentRef.current = true;
    onInitialReady?.();
  }, [loading, onInitialReady]);

  // Convert FullCalendar EventInput[] → AgendaCalendarEvent[]
  const eventsForCalendar: AgendaCalendarEvent[] = calendarEvents.map((e) => {
    const evt = e as AgendaCalendarEvent & {
      id?: string;
      title?: string;
      start?: string;
      end?: string;
      allDay?: boolean;
      backgroundColor?: string;
      extendedProps?: Record<string, unknown>;
    };
    return {
      id: String(evt.id ?? ""),
      title: String(evt.title ?? ""),
      start: String(evt.start ?? ""),
      end: evt.end ? String(evt.end) : "",
      allDay: evt.allDay ?? false,
      backgroundColor: evt.backgroundColor,
      extendedProps: evt.extendedProps ?? {},
    };
  });

  // Use a unique key to force full remount of the details sheet on each open
  const [sheetKey, setSheetKey] = useState(0);

  const handleEventClick = useCallback(
    async (eventId: string, occurrenceDate?: string) => {
      // Close any existing sheet first to force remount
      setDetailsSheetOpen(false);
      setSelectedEvent(null);

      try {
        const res = await fetch(`/api/agenda/events/${eventId}`, { cache: "reload" });
        const json = await res.json();
        if (!json.ok) return;

        const evt = json.event as {
          id: string;
          title: string;
          free_prompt: string | null;
          default_agent_id: string | null;
          timezone: string;
          starts_at: string;
          ends_at: string | null;
          recurrence_rule: string | null;
          status: "draft" | "active";
        };
        const evtProcesses = (json.processes ?? []) as Array<{ process_name: string; process_version_id?: string }>;
        const evtOccurrences = (json.occurrences ?? []) as Array<{ id: string; scheduled_for: string }>;

        const timezone = evt.timezone ?? "Europe/Amsterdam";
        const rawRecurrence = evt.recurrence_rule ?? "none";
        const recurrenceInfo = parseRecurrenceRule(rawRecurrence);

        // For recurring events, show the clicked occurrence date instead of the series start
        const isRecurring = rawRecurrence !== "none";

        // Find the occurrence matching the clicked date
        let occurrenceId: string | undefined;
        if (isRecurring && evtOccurrences.length > 0 && occurrenceDate) {
          // Match occurrence by comparing scheduled_for date in the event's timezone
          const matchingOcc = evtOccurrences.find((o) => {
            const { date: occDate } = extractDateTimeFields(o.scheduled_for, timezone);
            return occDate === occurrenceDate;
          });
          if (matchingOcc) {
            occurrenceId = matchingOcc.id;
          }
        }
        // For non-recurring: pick the latest occurrence
        if (!occurrenceId && !isRecurring && evtOccurrences.length > 0) {
          occurrenceId = evtOccurrences[0]?.id;
        }

        // Schedule display: for recurring events, always use the clicked date
        // so clicking Mar 29 shows Mar 29, not Mar 27
        const { time: eventTime } = extractDateTimeFields(evt.starts_at, timezone);
        const startDate = (isRecurring && occurrenceDate) ? occurrenceDate : extractDateTimeFields(evt.starts_at, timezone).date;
        const startTime = eventTime;
        const { date: endDate, time: endTime } = extractDateTimeFields(evt.ends_at, timezone);

        const summary: AgendaEventSummary = {
          id: String(evt.id ?? ""),
          title: String(evt.title ?? ""),
          request: evt.free_prompt ?? "",
          freePrompt: evt.free_prompt ?? "",
          agentId: evt.default_agent_id ?? "",
          agentName: "",
          processIds: evtProcesses.map((p) => p.process_version_id ?? "").filter(Boolean),
          processNames: evtProcesses.map((p) => p.process_name),
          status: evt.status ?? "draft",
          startDate,
          startTime,
          endDate,
          endTime,
          timezone,
          recurrence: recurrenceInfo.type,
          recurrenceRule: rawRecurrence !== "none" ? rawRecurrence : null,
          nextRuns: [],
          latestResult: null,
          occurrenceId,
          modelOverride: (evt as Record<string, unknown>).model_override as string ?? "",
          sessionTarget: ((evt as Record<string, unknown>).session_target === "main" ? "main" : "isolated") as "isolated" | "main",
          notifyChatId: (evt as Record<string, unknown>).notify_chat_id as string ?? null,
          createdAt: (evt as Record<string, unknown>).created_at as string ?? null,
          dependsOnEventId: (evt as Record<string, unknown>).depends_on_event_id as string ?? null,
        };

        setSelectedEvent(summary);
        setSheetKey((k) => k + 1);
        setDetailsSheetOpen(true);
      } catch {
        // ignore fetch errors
      }
    },
    []
  );

  const openedFromQueryRef = useRef(false);
  useEffect(() => {
    if (openedFromQueryRef.current) return;
    const eventId = searchParams.get("event");
    if (!eventId) return;
    if (loading) return;
    openedFromQueryRef.current = true;
    void handleEventClick(eventId);
  }, [searchParams, loading, handleEventClick]);

  const handleRetry = useCallback(
    async (occurrenceId: string, options?: { force?: boolean }) => {
      if (!selectedEvent) return;
      try {
        const res = await fetch(
          `/api/agenda/events/${selectedEvent.id}/occurrences/${occurrenceId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options?.force ? { force: true } : {}),
          }
        );
        const json = await res.json();
        if (json.ok) {
          toast.success("Retry requested");
          setDetailsSheetOpen(false);
          document.dispatchEvent(new CustomEvent("agenda-refresh"));
          return;
        }
        toast.error(json.error ?? "Retry failed");
      } catch {
        toast.error("Retry failed");
      }
    },
    [selectedEvent]
  );

  return (
    <>
      <Card className="border-2 shadow-lg rounded-2xl py-0 h-full min-h-0 flex flex-col">
        <div className="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Calendar</span>
          {headerActions && <div className="flex items-center gap-2">{headerActions}</div>}
        </div>
        <CardContent className="px-5 pb-5 pt-2 flex-1 min-h-0 overflow-hidden">
          <CustomMonthAgenda
            events={eventsForCalendar}
            loading={loading}
            viewMode={viewMode}
            currentDate={currentDate}
            onViewModeChange={setViewMode}
            onDateChange={setCurrentDate}
            onEventClick={handleEventClick}
            onDayClick={onDayClick}
            onEventDrop={onEventDrop}
            onAddEvent={onAddEvent}
            failedCount={failedCount}
            onOpenFailed={() => setFailedDialogOpen(true)}
          />
        </CardContent>
      </Card>

      <AgendaFailedDialog
        open={failedDialogOpen}
        onOpenChange={(open) => {
          setFailedDialogOpen(open);
          if (!open) void checkFailed();
        }}
      />

      <AgendaDetailsSheet
        key={sheetKey}
        open={detailsSheetOpen}
        event={selectedEvent}
        agents={agentsForDetails}
        onClose={() => { setDetailsSheetOpen(false); setSelectedEvent(null); }}
        onEdit={onEditEvent ?? (() => {})}
        onCopy={onCopyEvent}
        onRetry={handleRetry}
        onDelete={onDeleteEvent ?? (() => {})}
      />
    </>
  );
}

// ── Helpers (duplicated here to avoid circular dep from useAgenda) ─────────────

function parseRecurrenceRule(rule: string | null | undefined): {
  type: "none" | "daily" | "weekly" | "monthly";
  weekdays: string[];
} {
  if (!rule || rule === "none") return { type: "none", weekdays: [] };
  const dayMap: Record<string, string> = {
    SU: "0", MO: "1", TU: "2", WE: "3", TH: "4", FR: "5", SA: "6",
  };
  const bydayMatch = rule.match(/BYDAY=([^;]+)/);
  if (bydayMatch) {
    const days = bydayMatch[1].split(",").map((d) => dayMap[d] ?? d);
    return { type: "weekly", weekdays: days };
  }
  if (rule.includes("FREQ=DAILY")) return { type: "daily", weekdays: [] };
  if (rule.includes("FREQ=WEEKLY")) return { type: "weekly", weekdays: [] };
  if (rule.includes("FREQ=MONTHLY")) return { type: "monthly", weekdays: [] };
  return { type: "none", weekdays: [] };
}

function extractDateTimeFields(isoString: string | null | undefined, timezone: string) {
  if (!isoString) return { date: "", time: "" };
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return { date: "", time: "" };
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = fmt.formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
  } catch {
    return { date: isoString.split("T")[0], time: isoString.split("T")[1]?.slice(0, 5) ?? "" };
  }
}
