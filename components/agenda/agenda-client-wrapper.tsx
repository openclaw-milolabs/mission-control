"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { IconCalendarEvent, IconGitBranch } from "@tabler/icons-react";
import { toast } from "sonner";
import { AgendaPageClient } from "@/components/agenda/agenda-page-client";
import { AgendaEventModal, type AgendaEventFormData, type ChatOption } from "@/components/agenda/agenda-event-modal";
import { AgendaStatsCards } from "@/components/agenda/agenda-stats-cards";
import { AgendaTestPanel } from "@/components/agenda/agenda-test-panel";
import { ContainerLoader } from "@/components/ui/container-loader";
import type { AgendaEventSummary } from "@/components/agenda/agenda-details-sheet";

type AgentOption = { id: string; name: string };
type ProcessOption = { id: string; name: string; version_number: number };

/**
 * Build a local ISO 8601 datetime string (no Z suffix) from date + time.
 * This is NOT converted to UTC — the backend handles timezone conversion
 * using the `timezone` field in the request body.
 * e.g. ("2026-04-01", "18:50") → "2026-04-01T18:50:00"
 */
function buildLocalISO(date: string, time: string): string {
  return `${date}T${time}:00`;
}

function ymdInTimezone(value: string | Date, timezone: string): string {
  const d = value instanceof Date ? value : new Date(value);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toRecurrenceRule(recurrence: AgendaEventFormData["recurrence"], weekdays: string[]): string | null {
  if (recurrence === "none") return null;
  if (recurrence === "daily") return "FREQ=DAILY";
  if (recurrence === "weekly") {
    const days = weekdays.length > 0
      ? weekdays.sort().map((d) => ["SU","MO","TU","WE","TH","FR","SA"][Number(d)]).join(",")
      : "MO";
    return `FREQ=WEEKLY;BYDAY=${days}`;
  }
  if (recurrence === "monthly") return "FREQ=MONTHLY";
  return null;
}

function buildFormFromEvent(event: AgendaEventSummary): Partial<AgendaEventFormData> {
  const recurrence = (event.recurrence as AgendaEventFormData["recurrence"]) ?? "none";

  // Derive taskType and frequency from recurrence
  let taskType: "one_time" | "repeatable" = "one_time";
  let frequency: "daily" | "weekly" = "daily";
  if (recurrence === "daily" || recurrence === "weekly") {
    taskType = "repeatable";
    frequency = recurrence;
  }

  const startDateMode: "now" | "specific" = event.startDate ? "specific" : "now";
  const endDateMode: "forever" | "specific" = event.endDate ? "specific" : "forever";

  return {
    title: event.title,
    request: event.freePrompt ?? "",
    agentId: event.agentId ?? "",
    processVersionIds: event.processIds ?? [],
    status: event.status ?? "draft",
    startDate: event.startDate ?? "",
    startTime: event.startTime ?? "10:00",
    endDate: event.endDate ?? "",
    endTime: event.endTime ?? "",
    timezone: event.timezone ?? "Europe/Amsterdam",
    recurrence,
    taskType,
    frequency,
    startDateMode,
    endDateMode,
    modelOverride: event.modelOverride ?? "",
    sessionTarget: ((event as Record<string, unknown>).sessionTarget === "main" ? "main" : "isolated") as "isolated" | "main",
    notifyChatId: (event as Record<string, unknown>).notifyChatId as string ?? "",
    dependsOnEventId: (event as Record<string, unknown>).dependsOnEventId as string ?? "",
    dependencyTimeoutHours: (event as Record<string, unknown>).dependencyTimeoutHours as number ?? 0,
  };
}

export function AgendaClientWrapper() {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [processes, setProcesses] = useState<ProcessOption[]>([]);
  const [chats, setChats] = useState<ChatOption[]>([]);
  const [allEvents, setAllEvents] = useState<{ id: string; title: string }[]>([]);
  const [agendaInitialReady, setAgendaInitialReady] = useState(false);
  const [contentReady, setContentReady] = useState(false);

  // Modal state
  const [eventModalOpen, setEventModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<AgendaEventSummary | null>(null);
  const [editingFormData, setEditingFormData] = useState<Partial<AgendaEventFormData>>({});

  // Recurring edit scope dialog (used for modal saves)
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
  const [pendingEditData, setPendingEditData] = useState<AgendaEventFormData | null>(null);
  const [pendingOccurrenceId, setPendingOccurrenceId] = useState<string | null>(null);

  // Drag-drop pending state (used when moving a recurring event via drag)
  type PendingDrop = {
    eventId: string;
    newDate: string;
    newTime: string;
    sourceDate?: string;
    tz: string;
    isRecurring: boolean;
  };
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);

  // Load agents on mount (needed for details sheet labels). Processes are lazy-loaded on modal open.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const agentsRes = await fetch("/api/agents", { cache: "reload", signal: controller.signal });
        const agentsJson = await agentsRes.json();
        if (!controller.signal.aborted && agentsJson.agents) {
          setAgents(
            agentsJson.agents.map((a: { id: string; name: string }) => ({
              id: a.id,
              name: a.name,
            }))
          );
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          console.error("[agenda] failed to load agents", err);
        }
      }
      try {
        const chatsRes = await fetch("/api/agenda/chats", { cache: "reload", signal: controller.signal });
        const chatsJson = await chatsRes.json();
        if (!controller.signal.aborted && Array.isArray(chatsJson.chats)) {
          setChats(chatsJson.chats as ChatOption[]);
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          console.error("[agenda] failed to load chats", err);
        }
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!agendaInitialReady) return;
    const timer = setTimeout(() => setContentReady(true), 200);
    return () => clearTimeout(timer);
  }, [agendaInitialReady]);

  // Failsafe: never keep the page blocked behind loader indefinitely.
  useEffect(() => {
    if (contentReady) return;
    const safetyTimer = setTimeout(() => setContentReady(true), 3000);
    return () => clearTimeout(safetyTimer);
  }, [contentReady]);

  const loadProcessOptions = useCallback(async () => {
    if (processes.length > 0) return;
    try {
      const procsRes = await fetch("/api/processes", { cache: "reload" });
      const procsJson = await procsRes.json();
      if (procsJson.processes) {
        setProcesses(
          procsJson.processes
            .filter((p: { latest_version_id: string | null }) => p.latest_version_id)
            .map((p: { id: string; name: string; version_number: number | null; latest_version_id: string }) => ({
              id: p.latest_version_id,
              name: p.name,
              version_number: p.version_number ?? 1,
            }))
        );
      }
    } catch {
      // non-fatal; modal still opens
    }
  }, [processes.length]);

  const loadAllEventsForPicker = useCallback(async () => {
    try {
      const res = await fetch("/api/agenda/events?limit=200", { cache: "reload" });
      const json = await res.json();
      if (json.events) {
        setAllEvents((json.events as { id: string; title: string }[]).map((e) => ({ id: e.id, title: e.title })));
      }
    } catch { /* non-fatal */ }
  }, []);

  const openNewEventModal = () => {
    void loadProcessOptions();
    void loadAllEventsForPicker();
    setEditingEvent(null);
    setEditingFormData({});
    setEventModalOpen(true);
  };

  const handleCopyEvent = useCallback((event: AgendaEventSummary) => {
    void loadProcessOptions();
    void loadAllEventsForPicker();
    // Open the create modal pre-filled with the copied event's data (no editingEvent = creates new)
    setEditingEvent(null);
    setEditingFormData({
      ...buildFormFromEvent(event),
      title: `${event.title} (copy)`,
    });
    setEventModalOpen(true);
  }, [loadAllEventsForPicker, loadProcessOptions]);

  const handleDayClick = useCallback((date: Date) => {
    void loadProcessOptions();
    void loadAllEventsForPicker();
    const dateStr = date.toISOString().split("T")[0]; // yyyy-MM-dd
    setEditingEvent(null);
    setEditingFormData({ startDate: dateStr });
    setEventModalOpen(true);
  }, [loadAllEventsForPicker, loadProcessOptions]);

  const handleEventDrop = useCallback(async (eventId: string, newDate: string, newTime?: string, sourceDate?: string) => {
    try {
      // Fetch current event to get timezone + recurrence
      const res = await fetch(`/api/agenda/events/${eventId}`, { cache: "reload" });
      const json = await res.json();
      if (!json.ok) return;
      const evt = json.event;
      const tz = evt.timezone || "Europe/Amsterdam";

      // Use the new time if provided (week/day view drop), otherwise keep existing time
      let timeToUse: string;
      if (newTime) {
        timeToUse = newTime;
      } else {
        const d = new Date(evt.starts_at);
        const fmt = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz,
          hour: "2-digit", minute: "2-digit", hour12: false,
        });
        const parts = fmt.formatToParts(d);
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
        timeToUse = `${get("hour")}:${get("minute")}`;
      }

      const isRecurring = evt.recurrence_rule && evt.recurrence_rule !== "null" && evt.recurrence_rule !== "none";

      if (isRecurring) {
        // Show dialog to ask user: move this occurrence only, or this and future
        setPendingDrop({ eventId, newDate, newTime: timeToUse, sourceDate, tz, isRecurring: true });
        return;
      }

      // Non-recurring: move directly
      const newStartsAt = buildLocalISO(newDate, timeToUse);
      const patchRes = await fetch(`/api/agenda/events/${eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startsAt: newStartsAt, timezone: tz }),
      });
      const patchJson = await patchRes.json();
      if (patchJson.ok) {
        toast.success(newTime ? `Event moved to ${newDate} ${timeToUse}` : "Event moved");
      } else {
        toast.error(patchJson.error ?? "Failed to move event");
      }
    } catch {
      toast.error("Failed to move event");
    }
  }, []);

  const openEditEventModal = useCallback((event: AgendaEventSummary) => {
    void loadProcessOptions();
    setEditingEvent(event);
    setEditingFormData(buildFormFromEvent(event));
    setEventModalOpen(true);
  }, [loadProcessOptions]);

  const handleModalSave = (data: AgendaEventFormData) => {
    const isRecurring = data.recurrence !== "none" && editingEvent && editingEvent.recurrence !== "none";

    if (editingEvent && isRecurring) {
      setPendingEditData(data);
      setPendingOccurrenceId(editingEvent.occurrenceId ?? null);
      setScopeDialogOpen(true);
      setEventModalOpen(false);
      return;
    }

    saveEvent(data, null, null);
    setEventModalOpen(false);
  };

  const handleScopeSelect = (scope: "single" | "this_and_future") => {
    if (!pendingEditData) return;
    saveEvent(pendingEditData, scope, pendingOccurrenceId);
    setScopeDialogOpen(false);
    setPendingEditData(null);
    setPendingOccurrenceId(null);
  };

  // Handle recurring drag-drop scope selection
  const handleDropScopeSelect = async (scope: "single" | "this_and_future") => {
    if (!pendingDrop) return;
    const { eventId, newDate, newTime, sourceDate, tz } = pendingDrop;

    try {
      let occurrenceId: string | null = null;

      if (scope === "single") {
        // Find the occurrence matching the original (pre-move) date so the split point is correct
        const occRes = await fetch(`/api/agenda/events/${eventId}`, { cache: "reload" });
        const occJson = await occRes.json();
        if (!occJson.ok) { toast.error("Failed to find occurrence"); return; }
        const occurrences = occJson.occurrences ?? [];
        // Match by original source date in event timezone (fallback to target date)
        const targetDate = sourceDate || newDate;
        const matched = occurrences.find((o: { scheduled_for: string }) => {
          const occDate = ymdInTimezone(o.scheduled_for, tz);
          return occDate === targetDate;
        });
        occurrenceId = matched?.id ?? null;
      }

      // For "this_and_future", split from the dragged source occurrence date
      if (scope === "this_and_future") {
        const occRes = await fetch(`/api/agenda/events/${eventId}`, { cache: "reload" });
        const occJson = await occRes.json();
        if (!occJson.ok) { toast.error("Failed to find occurrence"); return; }
        const occurrences = occJson.occurrences ?? [];
        const targetDate = sourceDate || newDate;
        const matched = occurrences.find((o: { scheduled_for: string }) => {
          const occDate = ymdInTimezone(o.scheduled_for, tz);
          return occDate === targetDate;
        });
        occurrenceId = matched?.id ?? null;
      }

      const newStartsAt = buildLocalISO(newDate, newTime);
      const patchBody: Record<string, unknown> = {
        startsAt: newStartsAt,
        timezone: tz,
        editScope: scope,
        occurrenceId,
      };

      const patchRes = await fetch(`/api/agenda/events/${eventId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      const patchJson = await patchRes.json();
      if (patchJson.ok) {
        toast.success(
          scope === "single"
            ? `Moved only this occurrence to ${newDate} ${newTime}`
            : `Moved this and all upcoming to ${newDate} ${newTime}`
        );
      } else {
        toast.error(patchJson.error ?? "Failed to move event");
      }
    } catch {
      toast.error("Failed to move event");
    } finally {
      setPendingDrop(null);
    }
  };

  const saveEvent = async (
    data: AgendaEventFormData,
    scope: "single" | "this_and_future" | null,
    occurrenceId: string | null
  ) => {
    const tz = data.timezone || "Europe/Amsterdam";

    if (editingEvent) {
      const startsAt = data.startDate && data.startTime
        ? buildLocalISO(data.startDate, data.startTime)
        : data.startDate
          ? buildLocalISO(data.startDate, "10:00")
          : null;
      const endsAt = data.endDate
        ? buildLocalISO(data.endDate, data.endTime || "10:00")
        : null;
      const recurrenceRule = toRecurrenceRule(data.recurrence, data.weekdays);

      const body: Record<string, unknown> = {
        title: data.title,
        // API still expects freePrompt; value comes from data.request
        freePrompt: data.request || null,
        agentId: data.agentId || null,
        timezone: tz,
        startsAt,
        endsAt,
        recurrenceRule,
        status: data.status,
        processVersionIds: data.processVersionIds,
        modelOverride: data.modelOverride || "",
        sessionTarget: data.sessionTarget || "isolated",
        notifyChatId: data.notifyChatId || "",
        dependsOnEventId: data.dependsOnEventId || null,
        dependencyTimeoutHours: data.dependencyTimeoutHours || null,
        timeStepMinutes: data.timeStepMinutes,
      };

      if (scope) {
        body.editScope = scope;
        body.occurrenceId = occurrenceId;
      }

      const res = await fetch(`/api/agenda/events/${editingEvent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.ok) {
        let autoRetried = false;
        const shouldAutoRetry =
          editingEvent?.latestResult === "needs_retry" &&
          !!editingEvent?.occurrenceId &&
          scope !== "this_and_future";

        if (shouldAutoRetry) {
          const eventIdForRetry = editingEvent?.id;
          const occurrenceIdForRetry = editingEvent?.occurrenceId;
          try {
            const retryRes = await fetch(`/api/agenda/events/${eventIdForRetry}/occurrences/${occurrenceIdForRetry}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "retry", force: true }),
            });
            const retryJson = await retryRes.json();
            if (retryJson.ok) {
              autoRetried = true;
            } else {
              toast.warning(retryJson.error ?? "Event saved, but retry could not be started automatically");
            }
          } catch {
            toast.warning("Event saved, but retry could not be started automatically");
          }
        }

        toast.success(
          autoRetried
            ? "Event updated and retry started"
            : scope === "single"
              ? "Only this occurrence updated"
              : scope === "this_and_future"
                ? "This and all upcoming events updated"
                : "Event updated"
        );
      } else {
        toast.error(json.error ?? "Failed to update event");
      }
    } else {
      // Default to today if no startDate (e.g. repeatable "starts now")
      const effectiveStartDate = data.startDate || new Date().toISOString().split("T")[0];
      const effectiveStartTime = data.startTime || "10:00";
      const startsAt = buildLocalISO(effectiveStartDate, effectiveStartTime);
      const endsAt = data.endDate
        ? buildLocalISO(data.endDate, data.endTime || "10:00")
        : null;
      const recurrenceRule = toRecurrenceRule(data.recurrence, data.weekdays);

      const res = await fetch("/api/agenda/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "createEvent",
          title: data.title,
          // API still expects freePrompt; value comes from data.request
          freePrompt: data.request || null,
          agentId: data.agentId || null,
          timezone: tz,
          startsAt,
          endsAt,
          recurrenceRule,
          recurrenceUntil: data.recurrenceUntil || null,
          status: data.status,
          processVersionIds: data.processVersionIds,
          modelOverride: data.modelOverride || "",
          sessionTarget: data.sessionTarget || "isolated",
          notifyChatId: data.notifyChatId || "",
          dependsOnEventId: data.dependsOnEventId || null,
          dependencyTimeoutHours: data.dependencyTimeoutHours || null,
          timeStepMinutes: data.timeStepMinutes,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        toast.success("Event created");
      } else {
        toast.error(json.error ?? "Failed to create event");
      }
    }

    setEditingEvent(null);
    setEditingFormData({});
    void document.dispatchEvent(new CustomEvent("agenda-refresh"));
  };

  const handleDeleteEvent = async (eventId: string) => {
    try {
      const res = await fetch(`/api/agenda/events/${eventId}`, { method: "DELETE" });
      const json = await res.json();
      if (json.ok) {
        toast.success("Event deleted");
        // Close any open detail sheet for the deleted event
        document.dispatchEvent(new CustomEvent("agenda-refresh"));
      } else {
        toast.error(json.error ?? "Failed to delete event");
      }
    } catch {
      toast.error("Failed to delete event");
    }
  };

  return (
    <>
      <div className="@container/main relative flex flex-1 min-h-0 flex-col overflow-hidden">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: contentReady ? 1 : 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-1 min-h-0 flex-col gap-4 pt-4 pb-4 md:gap-6"
        >
          <div className="shrink-0">
            <AgendaStatsCards />
          </div>
          <div className="px-4 lg:px-6 flex-1 min-h-0">
            <AgendaPageClient
              onEditEvent={openEditEventModal}
              onCopyEvent={handleCopyEvent}
              onDeleteEvent={handleDeleteEvent}
              onDayClick={handleDayClick}
              onEventDrop={handleEventDrop}
              onAddEvent={openNewEventModal}
              agentsForDetails={agents}
              onInitialReady={() => setAgendaInitialReady(true)}

            />
          </div>
        </motion.div>

        {!contentReady && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <ContainerLoader label="Loading agenda…" />
          </motion.div>
        )}
      </div>

      <AgendaEventModal
        open={eventModalOpen}
        agents={agents}
        processes={processes}
        chats={chats}
        allEvents={allEvents}
        initialData={editingFormData}
        isReadOnly={
          editingEvent?.latestResult === "succeeded" &&
          (editingEvent?.recurrence === "none" || !editingEvent?.recurrence)
        }
        onClose={() => {
          setEventModalOpen(false);
          setEditingEvent(null);
          setEditingFormData({});
        }}
        onSave={handleModalSave}
      />

      <AlertDialog
        open={scopeDialogOpen}
        onOpenChange={(open: boolean) => {
          setScopeDialogOpen(open);
          if (!open) {
            setPendingEditData(null);
            setPendingOccurrenceId(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconGitBranch className="size-5 text-primary" />
              How should we apply these changes?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              This is a recurring event. Choose whether to change only this occurrence or this and all upcoming ones.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 mt-2">
            <Button
              variant="outline"
              className="h-auto py-4 justify-start text-left gap-3 cursor-pointer"
              onClick={() => handleScopeSelect("single")}
            >
              <IconCalendarEvent className="size-5 text-muted-foreground shrink-0" />
              <div className="flex flex-col gap-0.5 items-start min-w-0">
                <p className="font-semibold text-sm truncate w-full">Only this occurrence</p>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  Changes apply to this one instance only. Other occurrences stay the same.
                </p>
              </div>
            </Button>
            <Button
              variant="outline"
              className="h-auto py-4 justify-start text-left gap-3 cursor-pointer"
              onClick={() => handleScopeSelect("this_and_future")}
            >
              <IconGitBranch className="size-5 text-primary shrink-0" />
              <div className="flex flex-col gap-0.5 items-start min-w-0">
                <p className="font-semibold text-sm truncate w-full">This and all upcoming</p>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  This occurrence and all future ones change. Past occurrences are preserved.
                </p>
              </div>
            </Button>
          </div>
          <AlertDialogFooter className="mt-2">
            <AlertDialogCancel
              onClick={() => {
                setScopeDialogOpen(false);
                setPendingEditData(null);
                setPendingOccurrenceId(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Drag-drop recurring confirmation dialog */}
      <AlertDialog
        open={!!pendingDrop}
        onOpenChange={(open: boolean) => { if (!open) setPendingDrop(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconGitBranch className="size-5 text-primary" />
              Move — which occurrences?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              You moved a recurring event. Choose whether to move only this specific occurrence or this and all upcoming ones.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 mt-2">
            <Button
              variant="outline"
              className="h-auto py-4 justify-start text-left gap-3 cursor-pointer"
              onClick={() => handleDropScopeSelect("single")}
            >
              <IconCalendarEvent className="size-5 text-muted-foreground shrink-0" />
              <div className="flex flex-col gap-0.5 items-start min-w-0">
                <p className="font-semibold text-sm truncate w-full">Only this occurrence</p>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  Move only the one you just dragged. Other occurrences stay on their original schedule.
                </p>
              </div>
            </Button>
            <Button
              variant="outline"
              className="h-auto py-4 justify-start text-left gap-3 cursor-pointer"
              onClick={() => handleDropScopeSelect("this_and_future")}
            >
              <IconGitBranch className="size-5 text-primary shrink-0" />
              <div className="flex flex-col gap-0.5 items-start min-w-0">
                <p className="font-semibold text-sm truncate w-full">This and all upcoming</p>
                <p className="text-xs text-muted-foreground line-clamp-2">
                  Move this occurrence and all future ones to the new time. Past occurrences are preserved.
                </p>
              </div>
            </Button>
          </div>
          <AlertDialogFooter className="mt-2">
            <AlertDialogCancel onClick={() => setPendingDrop(null)}>
              Cancel
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AgendaTestPanel />
    </>
  );
}
