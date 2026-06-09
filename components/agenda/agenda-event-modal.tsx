"use client";

import { useEffect, useRef, useState } from "react";
import { useModels } from "@/lib/use-models";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  IconX,
  IconMicrophone,
  IconRobot,
  IconCalendarTime,
  IconCalendarPlus,
  IconRepeat,
  IconCalendarEvent,
  IconChevronRight,
  IconChevronLeft,
  IconCheck,
  IconStack2,
  IconCpu,
  IconServer,
  IconLink,
  IconTerminal2,
  IconBell,
  IconChevronDown } from "@tabler/icons-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AgendaSimulateModal } from "@/components/agenda/agenda-simulate-modal";
import { getProviderLabel } from "@/lib/models";

// ── Types ────────────────────────────────────────────────────────────────────

type RecurrenceType = "none" | "daily" | "weekly" | "monthly";
type TaskType = "one_time" | "repeatable";
type StartDateMode = "now" | "specific";
type EndDateMode = "forever" | "specific";
type Frequency = "daily" | "weekly";

export type AgendaEventFormData = {
  title: string;
  request: string;
  agentId: string;
  processVersionIds: string[];
  status: "draft" | "active";
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timezone: string;
  recurrence: RecurrenceType;
  weekdays: string[];
  recurrenceUntil: string;
  editOccurrenceId?: string;
  editScope?: "single" | "this_and_future";
  taskType: TaskType;
  modelOverride: string;
  startDateMode: StartDateMode;
  endDateMode: EndDateMode;
  frequency: Frequency;
  executionWindowMinutes: number;
  sessionTarget: "isolated" | "main";
  notifyChatId: string;            // "" = report to owner's private DM
  dependsOnEventId: string;        // "" = no dependency
  dependencyTimeoutHours: number;  // 0 = wait indefinitely
  timeStepMinutes?: number;
};

export type AgentOption = { id: string; name: string };
export type ProcessOption = { id: string; name: string; version_number: number };
export type ChatOption = { id: string; label: string; type: "private" | "group"; isDefault: boolean };

type Props = {
  open: boolean;
  agents?: AgentOption[];
  processes?: ProcessOption[];
  chats?: ChatOption[];
  allEvents?: { id: string; title: string }[];   // for dependency picker
  initialData?: Partial<AgendaEventFormData>;
  isReadOnly?: boolean;
  onClose: () => void;
  onSave: (data: AgendaEventFormData) => void;
};

// ── Constants ────────────────────────────────────────────────────────────────

const EMPTY_AGENTS: AgentOption[] = [];
const EMPTY_PROCESSES: ProcessOption[] = [];
const EMPTY_CHATS: ChatOption[] = [];

const TIMEZONES = [
  { value: "Europe/Amsterdam", label: "Europe/Amsterdam (CET)", abbr: "CET" },
  { value: "Europe/London", label: "Europe/London (GMT)", abbr: "GMT" },
  { value: "Europe/Berlin", label: "Europe/Berlin (CET)", abbr: "CET" },
  { value: "Europe/Paris", label: "Europe/Paris (CET)", abbr: "CET" },
  { value: "America/New_York", label: "America/New_York (EST)", abbr: "EST" },
  { value: "America/Chicago", label: "America/Chicago (CST)", abbr: "CST" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (PST)", abbr: "PST" },
  { value: "Asia/Tokyo", label: "Asia/Tokyo (JST)", abbr: "JST" },
  { value: "Asia/Dubai", label: "Asia/Dubai (GST)", abbr: "GST" },
  { value: "UTC", label: "UTC", abbr: "UTC" },
];

// Get a clean timezone abbreviation (e.g. "CET", "GMT") for display
function getTzAbbr(tz: string): string {
  const entry = TIMEZONES.find((t) => t.value === tz);
  if (entry) return entry.abbr;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

const WEEKDAYS = [
  { value: "1", label: "Mon" },
  { value: "2", label: "Tue" },
  { value: "3", label: "Wed" },
  { value: "4", label: "Thu" },
  { value: "5", label: "Fri" },
  { value: "6", label: "Sat" },
  { value: "0", label: "Sun" },
];

function buildTimeOptions(stepMinutes: number): { value: string; label: string }[] {
  const step = Math.max(1, Math.min(60, stepMinutes));
  const opts: { value: string; label: string }[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += step) {
      const val = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      opts.push({ value: val, label: val });
    }
  }
  return opts;
}

function snapToStep(minutes: number, stepMinutes: number): number {
  const step = Math.max(1, Math.min(60, stepMinutes));
  return Math.round(minutes / step) * step;
}

function getCurrentTimeInTz(tz: string, stepMinutes = 15): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DateTime } = require("luxon") as { DateTime: typeof import("luxon").DateTime };
    const now = DateTime.now().setZone(tz);
    const rawM = now.minute;
    const snapped = stepMinutes === 0 ? rawM : snapToStep(rawM, stepMinutes);
    const finalH = snapped >= 60 ? (now.hour + 1) % 24 : now.hour;
    const finalM = snapped >= 60 ? 0 : snapped;
    return `${String(finalH).padStart(2, "0")}:${String(finalM).padStart(2, "0")}`;
  } catch {
    return "10:00";
  }
}

function getTodayInTz(tz: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DateTime } = require("luxon") as { DateTime: typeof import("luxon").DateTime };
    const now = DateTime.now().setZone(tz);
    return now.toISODate() ?? new Date().toISOString().split("T")[0];
  } catch {
    return new Date().toISOString().split("T")[0];
  }
}

const STEPS = [
  { key: "type", label: "Type", icon: IconCalendarEvent },
  { key: "details", label: "Details", icon: IconMicrophone },
  { key: "schedule", label: "Schedule", icon: IconCalendarTime },
  { key: "review", label: "Review", icon: IconCheck },
] as const;

const defaultForm: AgendaEventFormData = {
  title: "",
  request: "",
  agentId: "",
  processVersionIds: [],
  status: "active",
  startDate: getTodayInTz("Europe/Amsterdam"),
  startTime: getCurrentTimeInTz("Europe/Amsterdam"),
  endDate: "",
  endTime: "",
  timezone: "Europe/Amsterdam",
  recurrence: "none",
  weekdays: [],
  recurrenceUntil: "",
  taskType: "one_time",
  modelOverride: "",
  startDateMode: "now",
  endDateMode: "forever",
  frequency: "daily",
  executionWindowMinutes: 30,
  sessionTarget: "isolated",
  notifyChatId: "",
  dependsOnEventId: "",
  dependencyTimeoutHours: 0,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseRecurrence(recurrenceRule: string | null): { type: RecurrenceType; weekdays: string[] } {
  if (!recurrenceRule || recurrenceRule === "none") return { type: "none", weekdays: [] };
  const bydayMatch = recurrenceRule.match(/BYDAY=([^;]+)/);
  if (bydayMatch) {
    const dayMap: Record<string, string> = { SU: "0", MO: "1", TU: "2", WE: "3", TH: "4", FR: "5", SA: "6" };
    const days = bydayMatch[1].split(",").map((d) => dayMap[d] ?? d);
    return { type: "weekly", weekdays: days };
  }
  if (recurrenceRule.includes("FREQ=DAILY")) return { type: "daily", weekdays: [] };
  if (recurrenceRule.includes("FREQ=WEEKLY")) return { type: "weekly", weekdays: [] };
  if (recurrenceRule.includes("FREQ=MONTHLY")) return { type: "monthly", weekdays: [] };
  return { type: "none", weekdays: [] };
}

function buildInitialForm(data: Partial<AgendaEventFormData>): AgendaEventFormData {
  const validTypes: RecurrenceType[] = ["none", "daily", "weekly", "monthly"];
  const isValidType = validTypes.includes(data.recurrence as RecurrenceType);

  const parsed = isValidType
    ? { type: data.recurrence as RecurrenceType, weekdays: data.weekdays ?? [] }
    : parseRecurrence(data.recurrence as unknown as string | null);

  let taskType: TaskType = data.taskType ?? "one_time";
  let frequency: Frequency = data.frequency ?? "daily";
  if (!data.taskType) {
    if (parsed.type === "daily" || parsed.type === "weekly") {
      taskType = "repeatable";
      frequency = parsed.type;
    } else {
      taskType = "one_time";
    }
  }

  const startDateMode: StartDateMode = data.startDateMode ?? (data.startDate ? "specific" : "now");
  const endDateMode: EndDateMode = data.endDateMode ?? (data.endDate ? "specific" : "forever");

  const sessionTarget = (data.sessionTarget === "main" ? "main" : "isolated") as "isolated" | "main";
  return {
    ...defaultForm,
    ...data,
    recurrence: parsed.type,
    weekdays: parsed.weekdays,
    recurrenceUntil: data.recurrenceUntil ?? "",
    taskType,
    frequency,
    modelOverride: data.modelOverride ?? "",
    startDateMode,
    endDateMode,
    executionWindowMinutes: data.executionWindowMinutes ?? 30,
    sessionTarget,
    notifyChatId: data.notifyChatId ?? "",
    dependsOnEventId: data.dependsOnEventId ?? "",
    dependencyTimeoutHours: data.dependencyTimeoutHours ?? 0,
  };
}

function buildPromptPreview(params: {
  title: string;
  context?: string;
  request: string;
  instructions: Array<{ title: string; instruction: string; skillKey?: string | null }>;
}) {
  // Mirror renderUnifiedTaskMessage from prompt-renderer.mjs exactly.
  // artifactDir is not known at preview time, so the output-file line is omitted
  // (matching the real renderer's behaviour when artifactDir is empty).
  const clean = (value: string | null | undefined) => String(value ?? "").trim();
  const sections: string[] = [];

  const genericTitles = new Set(["new event", "event", "test", "untitled", "new task", "task"]);
  const t = clean(params.title);
  if (t && !genericTitles.has(t.toLowerCase())) sections.push(`Task:\n${t}`);

  const c = clean(params.context);
  if (c) sections.push(`Context:\n${c}`);

  const validInstructions = params.instructions
    .map((step, index) => {
      const instruction = clean(step.instruction);
      if (!instruction) return null;
      const stepTitle = clean(step.title) || `Step ${index + 1}`;
      const skillTag = clean(step.skillKey) ? ` [Skill: ${clean(step.skillKey)}]` : "";
      return `${index + 1}. ${stepTitle}${skillTag} — ${instruction}`;
    })
    .filter((value): value is string => Boolean(value));

  if (validInstructions.length > 0) {
    sections.push(`Instructions:\n${validInstructions.join("\n")}`);
  }

  const request = clean(params.request);
  if (request) sections.push(`Request:\n${request}`);

  // Execution rules — always included (mirrors prompt-renderer.mjs)
  sections.push([
    "Execution rules:",
    "- Treat any mentioned skills, tools, or models as implementation guidance unless the request explicitly asks you to talk about them.",
    "- Do not respond with meta acknowledgements like 'I will', 'Using...', or tool-selection commentary unless the request explicitly asks for a plan.",
    "- Never announce which skill, tool, or method you're about to use. Just do the work.",
    "- If the request mentions a skill or tool by name, silently use it — do not describe your tool choice.",
    "- Start your response with the deliverable, not with commentary about how you'll produce it.",
    "- If you're generating content (text, code, images, etc.), output the content directly.",
    "- If the user asks for a deliverable, produce the deliverable directly.",
  ].join("\n"));

  // Output rules — always included (mirrors prompt-renderer.mjs).
  // The artifact-dir line is omitted here because it is only known at run time.
  sections.push([
    "Output rules:",
    "- Return only the requested deliverable.",
    "- Do not include internal labels, IDs, or system metadata.",
    "- Do not repeat section labels unless they help the final result.",
    "- Do not invent missing facts.",
  ].join("\n"));

  return sections.filter((s) => s.trim()).join("\n\n");
}

// ── Step indicator (floating cards) ─────────────────────────────────────────

function StepIndicator({ currentStep, onStepClick, canReach }: { currentStep: number; onStepClick: (i: number) => void; canReach?: (step: number) => boolean }) {
  return (
    <div className="flex gap-1.5 w-full">
      {STEPS.map((step, i) => {
        const isActive = i === currentStep;
        const isDone = i < currentStep;
        const isDisabled = i > currentStep && canReach && !canReach(i);
        return (
          <button
            key={step.key}
            type="button"
            onClick={() => !isDisabled && onStepClick(i)}
            disabled={isDisabled}
            className={[
              "flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg transition-all duration-200 border",
              isDisabled
                ? "bg-muted/20 text-muted-foreground/40 border-transparent cursor-not-allowed"
                : isActive
                  ? "bg-primary text-primary-foreground border-primary shadow-sm cursor-pointer"
                  : isDone
                    ? "bg-primary/10 text-primary border-primary/20 hover:bg-primary/15 cursor-pointer"
                    : "bg-muted/40 text-muted-foreground border-transparent hover:bg-muted/60 cursor-pointer",
            ].join(" ")}
          >
            <div className={[
              "flex items-center justify-center size-6 rounded-full text-[10px] font-bold shrink-0",
              isActive
                ? "bg-primary-foreground/20 text-primary-foreground"
                : isDone
                  ? "bg-primary/20 text-primary"
                  : "bg-muted-foreground/15 text-muted-foreground",
            ].join(" ")}>
              {isDone ? <IconCheck className="size-3" /> : i + 1}
            </div>
            <div className="flex flex-col items-start min-w-0">
              <span className="text-[11px] font-semibold leading-tight truncate">{step.label}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function AgendaEventModal({ open, agents = EMPTY_AGENTS, processes = EMPTY_PROCESSES, chats = EMPTY_CHATS, allEvents = [], initialData, isReadOnly, onClose, onSave }: Props) {
  const isEditing = !!initialData?.title;
  const [form, setForm] = useState<AgendaEventFormData>(initialData ? buildInitialForm(initialData) : defaultForm);
  const [error, setError] = useState("");
  const [step, setStep] = useState(0);
  const [agendaTimeStepMinutes, setAgendaTimeStepMinutes] = useState(() => {
    if (typeof window === "undefined") return 15;
    const raw = Number(window.localStorage.getItem("mc-agenda-time-step-minutes") ?? "15");
    return Number.isFinite(raw) ? Math.max(0, Math.min(60, raw)) : 15;
  });
  const [previewInstructions, setPreviewInstructions] = useState<Array<{ title: string; instruction: string; skillKey?: string | null }>>([]);
  const models = useModels();

  const initialDataRef = useRef(initialData);
  useEffect(() => {
    if (open) {
      initialDataRef.current = initialData;
    }
  }, [open, initialData]);

  useEffect(() => {
    const onStepChanged = (event: Event) => {
      const custom = event as CustomEvent<{ value?: number }>;
      const value = custom.detail?.value;
      const nextRaw = typeof value === "number" ? value : Number(localStorage.getItem("mc-agenda-time-step-minutes") ?? "15");
      const next = Number.isFinite(nextRaw) ? Math.max(0, Math.min(60, nextRaw)) : 15;
      setAgendaTimeStepMinutes(next);
    };

    window.addEventListener("mc-agenda-time-step-changed", onStepChanged as EventListener);
    return () => window.removeEventListener("mc-agenda-time-step-changed", onStepChanged as EventListener);
  }, []);

  useEffect(() => {
    if (!open) return;

    const frame = window.requestAnimationFrame(() => {
      const data = initialDataRef.current;
      setForm(
        data
          ? buildInitialForm(data)
          : {
              ...defaultForm,
              startDate: getTodayInTz(defaultForm.timezone),
              startTime: getCurrentTimeInTz(defaultForm.timezone, agendaTimeStepMinutes),
            }
      );
      setError("");
      // When editing, skip to details step since type is already set
      setStep(isEditing ? 1 : 0);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [open, isEditing, agendaTimeStepMinutes]);

  const updateField = <K extends keyof AgendaEventFormData>(key: K, value: AgendaEventFormData[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // No special clearing needed — model override works for all session targets.
      return next;
    });
    setError("");
  };

  const timeOptions = buildTimeOptions(agendaTimeStepMinutes === 0 ? 15 : agendaTimeStepMinutes);
  const effectivePreviewInstructions = form.processVersionIds.length === 0 ? [] : previewInstructions;

  useEffect(() => {
    if (!open) return;
    if (form.processVersionIds.length === 0) return;

    let cancelled = false;
    void (async () => {
      const nextInstructions: Array<{ title: string; instruction: string; skillKey?: string | null }> = [];
      for (const pid of form.processVersionIds) {
        try {
          const res = await fetch(`/api/processes/${pid}`, { cache: "reload" });
          const json = await res.json();
          if (!json.ok || !Array.isArray(json.steps)) continue;
          for (const step of json.steps) {
            const instruction = String(step.instruction ?? "").trim();
            if (!instruction) continue;
            nextInstructions.push({
              title: String(step.title || step.step_title || processes.find((p) => p.id === pid)?.name || "Step"),
              instruction,
              skillKey: step.skill_key || step.skillKey || null,
            });
          }
        } catch {
          // Best effort only; preview still shows request-only content.
        }
      }
      if (!cancelled) setPreviewInstructions(nextInstructions);
    })();

    return () => {
      cancelled = true;
    };
  }, [open, form.processVersionIds, processes]);

  const isValidTimeValue = (value: string): boolean => {
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) return false;
    if (agendaTimeStepMinutes === 0) return true;
    const minute = Number(value.split(":")[1] ?? "0");
    return minute % agendaTimeStepMinutes === 0;
  };

  const toggleWeekday = (day: string) => {
    const current = form.weekdays;
    updateField(
      "weekdays",
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()
    );
  };

  const removeProcess = (pid: string) => {
    updateField("processVersionIds", form.processVersionIds.filter((id) => id !== pid));
  };

  // ── Validation per step ────────────────────────────────────────────────────

  const validateStep = (s: number): string | null => {
    if (s === 1) {
      if (!form.title.trim()) return "Title is required";
      if (!form.request.trim() && form.processVersionIds.length === 0) {
        return "A request or at least one process is required";
      }
    }
    if (s === 2) {
      if (form.taskType === "one_time" && !form.startDate) return "Date is required for one-time events";
      if (!isValidTimeValue(form.startTime)) {
        return agendaTimeStepMinutes === 0
          ? "Time must be a valid HH:mm value"
          : `Time must align to ${agendaTimeStepMinutes}-minute intervals`;
      }
      if (form.taskType === "repeatable" && form.startDateMode === "specific" && !form.startDate) return "Start date is required";
      if (form.taskType === "repeatable" && form.endDateMode === "specific" && !form.endDate) return "End date is required";
    }
    return null;
  };

  const goNext = () => {
    const err = validateStep(step);
    if (err) { setError(err); toast.error(err); return; }
    setError("");
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const goBack = () => {
    setError("");
    setStep((s) => Math.max(s - 1, 0));
  };

  const canReachStep = (targetStep: number): boolean => {
    for (let s = 0; s < targetStep; s++) {
      if (validateStep(s)) return false;
    }
    return true;
  };

  const goToStep = (i: number) => {
    // Only allow going backward or to current step freely
    if (i <= step) {
      setError("");
      setStep(i);
      return;
    }
    // Going forward — validate all intermediate steps
    for (let s = step; s < i; s++) {
      const err = validateStep(s);
      if (err) { setError(err); toast.error(err); return; }
    }
    setError("");
    setStep(i);
  };

  const handleSave = () => {
    if (isReadOnly) return;
    const err = validateStep(1) || validateStep(2);
    if (err) { setError(err); return; }

    let derivedRecurrence: RecurrenceType = "none";
    if (form.taskType === "repeatable") {
      derivedRecurrence = form.frequency;
    }

    const saveData: AgendaEventFormData = {
      ...form,
      recurrence: derivedRecurrence,
      startDate: form.startDateMode === "now" && form.taskType === "repeatable" ? new Date().toISOString().split("T")[0] : form.startDate,
      endDate: form.endDateMode === "forever" ? "" : form.endDate,
      timeStepMinutes: agendaTimeStepMinutes,
    };

    onSave(saveData);
    setForm(defaultForm);
    setError("");
    setStep(0);
  };

  const handleClose = () => {
    setForm(defaultForm);
    setError("");
    setStep(0);
    onClose();
  };

  // ── Step renderers ─────────────────────────────────────────────────────────

  const renderTypeStep = () => (
    <div className="flex flex-col gap-4">
      <div className="text-center mb-2">
        <h3 className="text-base font-bold text-foreground">What kind of task is this?</h3>
        <p className="text-xs text-muted-foreground mt-1">Choose how this event should run</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => { updateField("taskType", "one_time"); goNext(); }}
          className={[
            "group relative flex flex-col items-center gap-3 rounded-xl border-2 p-6 transition-all duration-200 cursor-pointer",
            form.taskType === "one_time"
              ? "border-primary bg-primary/5 shadow-sm"
              : "border-border hover:border-primary/40 hover:bg-muted/40",
          ].join(" ")}
        >
          <div className={[
            "flex items-center justify-center size-14 rounded-xl transition-colors",
            form.taskType === "one_time" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary",
          ].join(" ")}>
            <IconCalendarEvent className="size-7" />
          </div>
          <div className="text-center">
            <p className="text-sm font-bold">One-time</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Runs once on a specific date</p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => { updateField("taskType", "repeatable"); goNext(); }}
          className={[
            "group relative flex flex-col items-center gap-3 rounded-xl border-2 p-6 transition-all duration-200 cursor-pointer",
            form.taskType === "repeatable"
              ? "border-primary bg-primary/5 shadow-sm"
              : "border-border hover:border-primary/40 hover:bg-muted/40",
          ].join(" ")}
        >
          <div className={[
            "flex items-center justify-center size-14 rounded-xl transition-colors",
            form.taskType === "repeatable" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary",
          ].join(" ")}>
            <IconRepeat className="size-7" />
          </div>
          <div className="text-center">
            <p className="text-sm font-bold">Repeatable</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Runs daily or weekly on a schedule</p>
          </div>
        </button>
      </div>
    </div>
  );

  const renderDetailsStep = () => (
    <div className="flex flex-col gap-4">
      {/* Title */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ae-title" className="text-xs font-semibold text-foreground/80">
          Title <span className="text-destructive ml-0.5">*</span>
        </Label>
        <Input
          id="ae-title"
          placeholder="e.g. Morning briefing"
          value={form.title}
          onChange={(e) => updateField("title", e.target.value)}
          className="h-10"
          autoFocus
        />
      </div>

      {/* Request */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ae-prompt" className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
          <IconMicrophone className="size-3.5 text-primary" />
          Request
        </Label>
        <Textarea
          id="ae-prompt"
          placeholder="What should the agent do?"
          value={form.request}
          onChange={(e) => updateField("request", e.target.value)}
          rows={5}
          className="resize-y min-h-[100px]"
        />
      </div>

      {/* Attached processes */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
          <IconStack2 className="size-3.5 text-primary" />
          Attached processes
        </Label>

        {form.processVersionIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {form.processVersionIds.map((pid) => {
              const proc = processes.find((p) => p.id === pid);
              return (
                <Badge
                  key={pid}
                  variant="secondary"
                  className="gap-1.5 pl-2.5 pr-1.5 py-1 text-xs font-semibold"
                >
                  {proc ? `${proc.name}${proc.version_number ? ` v${proc.version_number}` : ""}` : pid}
                  <button
                    type="button"
                    onClick={() => removeProcess(pid)}
                    className="ml-0.5 cursor-pointer hover:text-destructive rounded-sm transition-colors"
                  >
                    <IconX className="size-3" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}

        <Select
          onValueChange={(v) => {
            if (v && !form.processVersionIds.includes(v)) {
              updateField("processVersionIds", [...form.processVersionIds, v]);
            }
          }}
        >
          <SelectTrigger className="h-10 w-full cursor-pointer">
            <SelectValue placeholder="Attach a process..." />
          </SelectTrigger>
          <SelectContent>
            {processes.filter((p) => !form.processVersionIds.includes(p.id)).length === 0 ? (
              <SelectItem value="__empty__" disabled>
                {processes.length === 0 ? "No processes available" : "All processes attached"}
              </SelectItem>
            ) : (
              processes
                .filter((p) => !form.processVersionIds.includes(p.id))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}{p.version_number ? ` (v${p.version_number})` : ""}
                  </SelectItem>
                ))
            )}
          </SelectContent>
        </Select>
      </div>

      {/* Agent + model controls */}
      <div className={`grid gap-3 ${form.sessionTarget === "main" ? "grid-cols-1" : "grid-cols-2"}`}>
        {/* Agent */}
        <div className="flex flex-col gap-1.5 min-w-0">
          <Label className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
            <IconRobot className="size-3.5 text-primary" />
            Agent
          </Label>
          <Select value={form.agentId || "__none__"} onValueChange={(v) => {
            updateField("agentId", v === "__none__" ? "" : v);
            if (v === "__none__") updateField("modelOverride", "");
          }}>
            <SelectTrigger className="h-10 w-full cursor-pointer">
              <SelectValue placeholder="System default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">System default</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name || a.id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {form.sessionTarget !== "main" && (
          <>
            {/* Model Override */}
            <div className="flex flex-col gap-1.5 min-w-0">
              <Label className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
                <IconCpu className="size-3.5 text-primary" />
                Model override
              </Label>
              <Select
                value={form.modelOverride || "__default__"}
                onValueChange={(v) => updateField("modelOverride", v === "__default__" ? "" : v)}
              >
                <SelectTrigger className="h-10 w-full cursor-pointer">
                  <SelectValue placeholder="Agent default">
                    {form.modelOverride
                      ? <span className="flex gap-1.5 items-center truncate">
                          <span className="font-medium truncate">{models.find((m) => m.id === form.modelOverride)?.alias ?? form.modelOverride}</span>
                          <span className="text-muted-foreground text-[10px] shrink-0">({getProviderLabel(form.modelOverride)})</span>
                        </span>
                      : "Agent default"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">Agent default</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="font-medium">{m.alias}</span>
                      <span className="text-muted-foreground text-xs ml-2">({getProviderLabel(m.id)})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>

      {/* Session Target */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
          <IconServer className="size-3.5 text-primary" />
          Execution mode
        </Label>
        <Select
          value={form.sessionTarget}
          onValueChange={(v) => updateField("sessionTarget", v as "isolated" | "main")}
        >
          <SelectTrigger className="h-10 w-full cursor-pointer">
            <SelectValue>
              {form.sessionTarget === "main" ? "Main session" : "Isolated session"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="isolated">
              <div className="flex flex-col py-0.5">
                <span className="font-medium">Isolated session</span>
                <span className="text-xs text-muted-foreground">
                  Fresh session every time — no history, no shared state.
                </span>
              </div>
            </SelectItem>
            <SelectItem value="main">
              <div className="flex flex-col py-0.5">
                <span className="font-medium">Main session</span>
                <span className="text-xs text-muted-foreground">
                  Persistent main session — full memory and context.
                </span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
        {form.sessionTarget === "main" && (
          <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5 mt-0.5">
            <span className="mt-0.5">&#9888;</span>
            <span>Main session shares context with your live chat. Avoid long-running or noisy tasks here.</span>
          </p>
        )}
      </div>

      {/* Report to — Telegram destination for completion/failure notifications */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
          <IconBell className="size-3.5 text-primary" />
          Report to
        </Label>
        <Select
          value={form.notifyChatId || "__private__"}
          onValueChange={(v) => updateField("notifyChatId", v === "__private__" ? "" : v)}
        >
          <SelectTrigger className="h-10 w-full cursor-pointer">
            <SelectValue>
              {(() => {
                if (!form.notifyChatId) return "Private (default)";
                const match = chats.find((c) => c.id === form.notifyChatId);
                return match ? match.label : `Chat ${form.notifyChatId}`;
              })()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__private__">
              <div className="flex flex-col py-0.5">
                <span className="font-medium">Private (default)</span>
                <span className="text-xs text-muted-foreground">Send the report to your private DM.</span>
              </div>
            </SelectItem>
            {chats
              .filter((c) => !c.isDefault)
              .map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  <div className="flex flex-col py-0.5">
                    <span className="font-medium">{c.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.type === "group" ? "Group chat" : "Private chat"} · {c.id}
                    </span>
                  </div>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-0.5">
          Where this task posts its result when it finishes or fails.
        </p>
      </div>

      {/* Dependency — only show when there are other events to pick from */}
      {allEvents.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
            <IconLink className="size-3.5 text-primary" />
            Depends on event
          </Label>
          <Select
            value={form.dependsOnEventId || "__none__"}
            onValueChange={(v) => updateField("dependsOnEventId", v === "__none__" ? "" : v)}
          >
            <SelectTrigger className="h-10 w-full cursor-pointer">
              <SelectValue>
                {form.dependsOnEventId
                  ? (allEvents.find((e) => e.id === form.dependsOnEventId)?.title ?? "Unknown event")
                  : "No dependency"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">No dependency</SelectItem>
              {allEvents.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {form.dependsOnEventId && (
            <div className="flex flex-col gap-1.5 mt-1">
              <Label className="text-xs font-semibold text-foreground/80">Timeout (hours, 0 = wait indefinitely)</Label>
              <Input
                type="number"
                min={0}
                max={168}
                value={form.dependencyTimeoutHours}
                onChange={(e) => updateField("dependencyTimeoutHours", Math.max(0, Number(e.target.value)))}
                className="h-10 w-32"
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">
                This event will wait for the matching occurrence of the selected event to succeed. If that occurrence is skipped, failed, or times out — this occurrence is also skipped.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Status — full width */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-semibold text-foreground/80">Status</Label>
        <Select value={form.status} onValueChange={(v) => updateField("status", v as "draft" | "active")}>
          <SelectTrigger className="h-10 w-full cursor-pointer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  const renderScheduleStep = () => (
    <div className="flex flex-col gap-4">
      {/* ── One-time: just date + time ─────────────────────────────── */}
      {form.taskType === "one_time" && (
        <>
          <div className="text-center mb-1">
            <h3 className="text-base font-bold text-foreground">When should it run?</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Pick the date and time for this one-time task</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ae-ot-date" className="text-xs font-semibold text-foreground/80">
                Date <span className="text-destructive">*</span>
              </Label>
              <Input
                id="ae-ot-date"
                type="date"
                value={form.startDate}
                onChange={(e) => updateField("startDate", e.target.value)}
                className="h-10"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-semibold text-foreground/80">
                Time
              </Label>
              {agendaTimeStepMinutes === 0 ? (
                <Input
                  type="time"
                  step={60}
                  value={form.startTime}
                  onChange={(e) => updateField("startTime", e.target.value)}
                  className="h-10"
                />
              ) : (
                <Select value={form.startTime} onValueChange={(v) => updateField("startTime", v)}>
                  <SelectTrigger className="h-10 w-full cursor-pointer">
                    <SelectValue placeholder="Select time" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[280px]">
                    {timeOptions.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Repeatable: frequency, time, start/end ─────────────────── */}
      {form.taskType === "repeatable" && (
        <>
          <div className="text-center mb-1">
            <h3 className="text-base font-bold text-foreground">Set the schedule</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Configure frequency, timing, and duration</p>
          </div>

          {/* Frequency + Time */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5 min-w-0">
              <Label className="text-xs font-semibold text-foreground/80">Frequency</Label>
              <Select value={form.frequency} onValueChange={(v) => updateField("frequency", v as Frequency)}>
                <SelectTrigger className="h-10 w-full cursor-pointer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-semibold text-foreground/80">
                Time
              </Label>
              {agendaTimeStepMinutes === 0 ? (
                <Input
                  type="time"
                  step={60}
                  value={form.startTime}
                  onChange={(e) => updateField("startTime", e.target.value)}
                  className="h-10"
                />
              ) : (
                <Select value={form.startTime} onValueChange={(v) => updateField("startTime", v)}>
                  <SelectTrigger className="h-10 w-full cursor-pointer">
                    <SelectValue placeholder="Select time" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[280px]">
                    {timeOptions.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {/* Weekly: weekday toggle */}
          {form.frequency === "weekly" && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-semibold text-foreground/80">Days</Label>
              <div className="grid grid-cols-7 gap-1.5">
                {WEEKDAYS.map((day) => (
                  <Button
                    key={day.value}
                    size="sm"
                    variant={form.weekdays.includes(day.value) ? "default" : "outline"}
                    onClick={() => toggleWeekday(day.value)}
                    className="h-9 text-xs font-semibold cursor-pointer w-full"
                  >
                    {day.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {/* Start date: Now or specific */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground/80">Starts</Label>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                size="sm"
                variant={form.startDateMode === "now" ? "default" : "outline"}
                onClick={() => { updateField("startDateMode", "now"); updateField("startDate", ""); }}
                className="h-9 cursor-pointer w-full"
              >
                Now
              </Button>
              <Button
                size="sm"
                variant={form.startDateMode === "specific" ? "default" : "outline"}
                onClick={() => updateField("startDateMode", "specific")}
                className="h-9 cursor-pointer w-full"
              >
                Specific date
              </Button>
            </div>
            {form.startDateMode === "specific" && (
              <Input
                type="date"
                value={form.startDate}
                onChange={(e) => updateField("startDate", e.target.value)}
                className="h-10"
              />
            )}
          </div>

          {/* End date: Forever or specific */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold text-foreground/80">Ends</Label>
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                size="sm"
                variant={form.endDateMode === "forever" ? "default" : "outline"}
                onClick={() => { updateField("endDateMode", "forever"); updateField("endDate", ""); }}
                className="h-9 cursor-pointer w-full"
              >
                Forever
              </Button>
              <Button
                size="sm"
                variant={form.endDateMode === "specific" ? "default" : "outline"}
                onClick={() => updateField("endDateMode", "specific")}
                className="h-9 cursor-pointer w-full"
              >
                Specific date
              </Button>
            </div>
            {form.endDateMode === "specific" && (
              <Input
                type="date"
                value={form.endDate}
                onChange={(e) => updateField("endDate", e.target.value)}
                className="h-10"
              />
            )}
          </div>
        </>
      )}

      {/* Timezone — always full width */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ae-tz" className="text-xs font-semibold text-foreground/80">
          Timezone
        </Label>
        <Select value={form.timezone} onValueChange={(v) => { updateField("timezone", v); updateField("startDate", getTodayInTz(v)); updateField("startTime", getCurrentTimeInTz(v, agendaTimeStepMinutes)); }}>
          <SelectTrigger id="ae-tz" className="h-10 w-full cursor-pointer">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );

  const renderReviewStep = () => {
    const agentName = form.agentId ? (agents.find((a) => a.id === form.agentId)?.name || form.agentId) : "System default";
    const modelName = form.modelOverride ? (models.find((m) => m.id === form.modelOverride)?.alias || form.modelOverride) : "Agent default";
    const processNames = form.processVersionIds.map((pid) => {
      const proc = processes.find((p) => p.id === pid);
      return proc ? proc.name : pid;
    });
    const weekdayLabels = form.weekdays.map((v) => WEEKDAYS.find((w) => w.value === v)?.label ?? v).join(", ");
    const promptPreview = buildPromptPreview({
      title: form.title,
      request: form.request,
      instructions: effectivePreviewInstructions,
    });

    return (
      <div className="flex flex-col gap-3">
        <div className="text-center mb-1">
          <h3 className="text-base font-bold text-foreground">Review & create</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Make sure everything looks right</p>
        </div>

        <div className="rounded-xl border bg-muted/20 divide-y">
          <ReviewRow label="Type" value={form.taskType === "one_time" ? "One-time" : "Repeatable"} />
          <ReviewRow label="Title" value={form.title} />
          {form.request && <ReviewRow label="Request" value={form.request} truncate />}
          {processNames.length > 0 && <ReviewRow label="Processes" value={processNames.join(", ")} />}
          <ReviewRow label="Agent" value={agentName} />
          {form.modelOverride && <ReviewRow label="Model" value={modelName} />}
          <ReviewRow label="Status" value={form.status === "draft" ? "Draft" : "Active"} />

          {form.taskType === "one_time" ? (
            <>
              <ReviewRow label="Date" value={form.startDate || "—"} />
              <ReviewRow label="Time" value={form.startTime ? `${form.startTime} ${getTzAbbr(form.timezone)}` : "—"} />
            </>
          ) : (
            <>
              <ReviewRow label="Frequency" value={form.frequency === "daily" ? "Daily" : "Weekly"} />
              {form.frequency === "weekly" && weekdayLabels && (
                <ReviewRow label="Days" value={weekdayLabels} />
              )}
              <ReviewRow label="Time" value={form.startTime ? `${form.startTime} ${getTzAbbr(form.timezone)}` : "—"} />
              <ReviewRow label="Starts" value={form.startDateMode === "now" ? "Immediately" : (form.startDate || "—")} />
              <ReviewRow label="Ends" value={form.endDateMode === "forever" ? "Runs forever" : (form.endDate || "—")} />
            </>
          )}

          <ReviewRow label="Timezone" value={form.timezone} />
          {/* executionWindowMinutes uses global default from settings */}
          <ReviewRow label="Execution" value={form.sessionTarget === "main" ? "Main session" : "Isolated session"} />
          <ReviewRow
            label="Report to"
            value={form.notifyChatId
              ? (chats.find((c) => c.id === form.notifyChatId)?.label ?? `Chat ${form.notifyChatId}`)
              : "Private (default)"}
          />
          {form.dependsOnEventId && (
            <ReviewRow
              label="Depends on"
              value={allEvents.find((e) => e.id === form.dependsOnEventId)?.title ?? form.dependsOnEventId}
            />
          )}

          {/* Simulate section — only show if there's something to simulate */}
          {(form.request || form.processVersionIds.length > 0) && (
            <div className="p-3">
              <AgendaSimulateModal
                open={true}
                formData={form}
                onClose={() => {}}
              />
            </div>
          )}

          {(form.title.trim() || form.request.trim() || form.processVersionIds.length > 0) && (
            <div className="px-4 pb-4 pt-2">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl border bg-muted/30 px-4 py-3 transition-colors hover:bg-muted/50 select-none">
                  <span className="flex items-center justify-center size-7 rounded-lg bg-primary/10 shrink-0">
                    <IconTerminal2 className="size-3.5 text-primary" />
                  </span>
                  <span className="flex-1 text-sm font-semibold text-foreground">Preview input sent to agent</span>
                  <IconChevronDown className="size-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
                </summary>

                <div className="mt-2 rounded-xl border bg-card overflow-hidden shadow-sm">
                  {/* Header bar */}
                  <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-muted/20">
                    <span className="size-2 rounded-full bg-red-400/70" />
                    <span className="size-2 rounded-full bg-yellow-400/70" />
                    <span className="size-2 rounded-full bg-green-400/70" />
                    <span className="ml-2 text-[10px] font-mono text-muted-foreground/60 tracking-wide">prompt-renderer.mjs — live preview</span>
                  </div>
                  {/* Prompt content */}
                  <div className="max-h-[340px] overflow-y-auto">
                    <div className="p-4 font-mono text-[11.5px] leading-relaxed">
                      {promptPreview.split("\n").map((line, i) => {
                        const isSectionHeader = /^(Task|Context|Instructions|Request|Execution rules|Output rules):$/.test(line.trim());
                        const isRule = /^- /.test(line);
                        const isNumbered = /^\d+\./.test(line.trim());
                        const isEmpty = line.trim() === "";
                        return (
                          <div key={i} className={isEmpty ? "h-3" : "leading-relaxed"}>
                            {isSectionHeader ? (
                              <span className="text-primary font-bold text-[11px] uppercase tracking-widest opacity-80">{line}</span>
                            ) : isRule ? (
                              <span className="text-muted-foreground/70 text-[11px]">
                                <span className="text-primary/50 mr-1">–</span>
                                {line.slice(2)}
                              </span>
                            ) : isNumbered ? (
                              <span className="text-foreground/80 text-[11px]">
                                <span className="text-primary/60 mr-1">{line.match(/^(\d+\.)/)?.[1]}</span>
                                {line.replace(/^\d+\.\s*/, "")}
                              </span>
                            ) : (
                              <span className="text-foreground/85 text-[11px]">{line}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="sm:max-w-[600px] max-h-[92vh] overflow-y-auto p-0">
        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-0">
          <div className="flex items-center gap-3 mb-1">
            <div className={[
              "flex items-center justify-center size-9 rounded-lg shrink-0",
              isEditing ? "bg-primary/10" : "bg-primary",
            ].join(" ")}>
              <IconCalendarPlus className={[
                "size-4.5",
                isEditing ? "text-primary" : "text-primary-foreground",
              ].join(" ")} />
            </div>
            <div>
              <DialogTitle className="text-lg">
                {isEditing ? "Edit event" : "New agenda event"}
              </DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {isEditing
                  ? "Update the event. For recurring events you'll choose how to apply changes."
                  : "Schedule a task to run automatically — follow the steps below."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Step indicator */}
        <div className="px-6 pt-3">
          <StepIndicator currentStep={step} onStepClick={goToStep} canReach={canReachStep} />
        </div>

        {/* Step content */}
        <div className="px-6 py-4 min-h-[280px]">
          {step === 0 && renderTypeStep()}
          {step === 1 && renderDetailsStep()}
          {step === 2 && renderScheduleStep()}
          {step === 3 && renderReviewStep()}

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive mt-4">
              {error}
            </div>
          )}
        </div>

        {/* Footer navigation */}
        <DialogFooter className="px-6 pb-6 pt-0">
          <div className="flex items-center justify-between w-full gap-2">
            <div>
              {step > 0 && (
                <Button variant="ghost" onClick={goBack} className="gap-1.5 cursor-pointer">
                  <IconChevronLeft className="size-3.5" />
                  Back
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={handleClose} className="cursor-pointer">
                Cancel
              </Button>
              {step < STEPS.length - 1 ? (
                <Button onClick={goNext} className="gap-1.5 cursor-pointer">
                  Next
                  <IconChevronRight className="size-3.5" />
                </Button>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          onClick={handleSave}
                          disabled={isReadOnly}
                          className="gap-1.5 cursor-pointer"
                        >
                          <IconCalendarPlus className="size-3.5" />
                          {isEditing ? "Save changes" : "Create event"}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {isReadOnly && (
                      <TooltipContent side="top" className="max-w-xs text-left">
                        This one-time event has already finished. Use &quot;Retry&quot; or copy the details to create a new event instead.
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Review row helper ────────────────────────────────────────────────────────

function ReviewRow({ label, value, truncate }: { label: string; value: string; truncate?: boolean }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span className="text-xs font-semibold text-muted-foreground w-20 shrink-0 pt-0.5">{label}</span>
      <span className={["text-sm text-foreground flex-1", truncate ? "line-clamp-2" : ""].join(" ")}>
        {value}
      </span>
    </div>
  );
}
