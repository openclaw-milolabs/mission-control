"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconDotsVertical } from "@tabler/icons-react";
import { formatDuration, LiveDuration } from "@/hooks/use-now";
import {
  IconCalendar,
  IconCalendarClock,
  IconClock,
  IconRepeat,
  IconRefresh,
  IconX,
  IconUser,
  IconBrain,
  IconFileText,

  IconPencil,
  IconDownload,
  IconPhoto,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconHash,
  IconLock,
  IconCopy,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { STATUS_BADGE_MAP, STATUS_BADGE_FALLBACK, STATUS_HEX } from "@/lib/status-colors";


export type AgendaEventSummary = {
  id: string;
  title: string;
  // Stored as free_prompt in DB but called "request" in the UI.
  /** @deprecated use request instead */
  freePrompt: string;
  /** The request text (UI-friendly name for free_prompt). */
  request?: string;
  agentId: string;
  agentName: string;
  processIds: string[];
  processNames: string[];
  status: "draft" | "active";
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timezone: string;
  recurrence: string;
  nextRuns: string[];
  latestResult:
    | "pending"
    | "scheduled"
    | "queued"
    | "running"
    | "auto_retry"
    | "stale_recovery"
    | "succeeded"
    | "needs_retry"
    | "failed"
    | "cancelled"
    | "skipped"
    | null;
  recurrenceRule?: string | null;
  occurrenceId?: string;
  modelOverride?: string;
  executionWindowMinutes?: number;
  sessionTarget?: "isolated" | "main";
  notifyChatId?: string | null;
  createdAt?: string | null;
  dependsOnEventId?: string | null;
  dependsOnEventTitle?: string | null;
};

type RunAttempt = {
  id: string;
  attempt_no: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error_message: string | null;
};

type ArtifactFile = {
  name: string;
  mimeType: string;
  size: number;
  path: string;
};

type RunStep = {
  id: string;
  run_attempt_id: string;
  step_order: number;
  step_title: string | null;
  step_instruction: string | null;
  process_name: string | null;
  skill_key: string | null;
  input_payload: string | Record<string, unknown> | null;
  agent_id: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  output_payload: string | Record<string, unknown> | null;
  artifact_payload: string | { files: ArtifactFile[] } | null;
  error_message: string | null;
};

type Props = {
  open: boolean;
  event: AgendaEventSummary | null;
  agents?: { id: string; name: string }[];
  onClose: () => void;
  onEdit: (event: AgendaEventSummary) => void;
  onCopy?: (event: AgendaEventSummary) => void;
  onRetry: (occurrenceId: string, options?: { force?: boolean }) => void;
  onDelete: (eventId: string) => void;
};

function getTimezoneAbbr(timezone: string, date?: Date): string {
  try {
    const d = date || new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      timeZoneName: 'short',
    }).formatToParts(d);
    return parts.find(p => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

function formatTime(ts: string | null, timezone?: string) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString(undefined, {
      timeZone: timezone || undefined,
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

function beautifyOutputSource(source: string | null | undefined) {
  const raw = String(source ?? "").trim();
  if (!raw) return "";
  // Step 1: fix common typos/misspellings first (order matters — specific before general)
  const s = raw
    .replace(/_session_/gi, " Session ")
    // Normalize any variant of "assistant" (assistan, assisant, assisstant, assistent, etc.)
    .replace(/assis[st]?[aie][n]?[st]?s?/gi, "Assistant")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Step 2: title-case each word
  return s.replace(/\b([a-z])([a-z]*)\b/gi, (_match, first, rest) =>
    first.toUpperCase() + rest.toLowerCase()
  );
}

/** Wrap any element with a Radix tooltip */
function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  if (!text) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} className="max-w-[260px]">{text}</TooltipContent>
    </Tooltip>
  );
}

function ResultBadge({ status }: { status: string | null }) {
  const cfg = STATUS_BADGE_MAP[status ?? ""] ?? { ...STATUS_BADGE_FALLBACK, label: status ?? STATUS_BADGE_FALLBACK.label };
  return (
    <Tip text={cfg.tooltip}>
      <Badge variant="outline" className={`text-[10px] uppercase tracking-wider ${cfg.className}`}>
        {cfg.label}
      </Badge>
    </Tip>
  );
}

function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headers
    if (line.startsWith("### ")) {
      nodes.push(<h4 key={i} className="text-sm font-bold mt-3 mb-1">{renderInline(line.slice(4))}</h4>);
    } else if (line.startsWith("## ")) {
      nodes.push(<h3 key={i} className="text-base font-bold mt-3 mb-1">{renderInline(line.slice(3))}</h3>);
    } else if (line.startsWith("# ")) {
      nodes.push(<h2 key={i} className="text-lg font-bold mt-3 mb-1">{renderInline(line.slice(2))}</h2>);
    }
    // List items
    else if (/^[-*]\s/.test(line)) {
      nodes.push(
        <div key={i} className="flex gap-2 pl-1">
          <span className="text-muted-foreground shrink-0">•</span>
          <span className="text-sm leading-relaxed">{renderInline(line.replace(/^[-*]\s/, ""))}</span>
        </div>
      );
    }
    // Numbered list
    else if (/^\d+\.\s/.test(line)) {
      const num = line.match(/^(\d+)\./)?.[1];
      nodes.push(
        <div key={i} className="flex gap-2 pl-1">
          <span className="text-muted-foreground shrink-0 tabular-nums text-sm">{num}.</span>
          <span className="text-sm leading-relaxed">{renderInline(line.replace(/^\d+\.\s/, ""))}</span>
        </div>
      );
    }
    // Empty line
    else if (line.trim() === "") {
      nodes.push(<div key={i} className="h-2" />);
    }
    // Normal paragraph
    else {
      nodes.push(<p key={i} className="text-sm leading-relaxed">{renderInline(line)}</p>);
    }
  }

  return nodes;
}

function renderInline(text: string): React.ReactNode {
  // Process inline markdown: **bold**, *italic*, `code`
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Code
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(<code key={key++} className="px-1 py-0.5 bg-muted rounded text-xs font-mono">{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }
    // Bold
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parts.push(<strong key={key++} className="font-bold">{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }
    // Italic
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) {
      parts.push(<em key={key++}>{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }
    // Plain text (up to next special char)
    const nextSpecial = remaining.search(/[`*]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      // Special char that didn't match a pattern — emit as text
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ── Agenda occurrence logs ───────────────────────────────────────────────────────────────

type AgendaLogEntry = {
  id: string;
  occurred_at: string;
  level: string;
  event_type: string;
  message: string;
  raw_payload: Record<string, unknown> | null;
};

function AgendaOccurrenceLogs({ occurrenceId }: { occurrenceId: string | null }) {
  const [logs, setLogs] = useState<AgendaLogEntry[]>([]);
  const [loadedOccurrenceId, setLoadedOccurrenceId] = useState<string | null>(null);
  const visibleLogs = occurrenceId ? logs : [];
  const loading = Boolean(occurrenceId) && loadedOccurrenceId !== occurrenceId;

  useEffect(() => {
    if (!occurrenceId) return;
    let cancelled = false;

    fetch(`/api/agenda/logs?occurrenceId=${encodeURIComponent(occurrenceId)}&limit=50`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setLogs(d.ok ? (d.logs ?? []) : []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadedOccurrenceId(occurrenceId);
      });

    return () => {
      cancelled = true;
    };
  }, [occurrenceId]);

  if (!occurrenceId) return (
    <p className="text-xs text-muted-foreground py-4 text-center">Select an occurrence to view its logs.</p>
  );

  if (loading) return (
    <div className="flex flex-col gap-2 py-2">
      {[0,1,2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  );

  if (visibleLogs.length === 0) return (
    <p className="text-xs text-muted-foreground py-4 text-center">
      No logs found for this occurrence.
    </p>
  );

  const eventLabel: Record<string, string> = {
    "agenda.created": "Created",
    "agenda.queued": "Queued",
    "agenda.started": "Running",
    "agenda.output_captured": "Output captured",
    "agenda.succeeded": "Succeeded",
    "agenda.failed": "Failed",
    "agenda.fallback": "Fallback queued",
    "agenda.skipped": "Skipped",
    "agenda.cancelled": "Cancelled",
  };
  const eventTone: Record<string, CSSProperties> = {
    "agenda.created": {},
    "agenda.queued": {},
    "agenda.started": { color: STATUS_HEX.running },
    "agenda.output_captured": {},
    "agenda.succeeded": { color: STATUS_HEX.succeeded },
    "agenda.failed": { color: STATUS_HEX.failed },
    "agenda.fallback": { color: STATUS_HEX.auto_retry },
    "agenda.skipped": { color: STATUS_HEX.skipped },
    "agenda.cancelled": {},
  };

  return (
    <div className="flex flex-col gap-2">
      {visibleLogs.map((log) => (
        <div key={log.id} className="rounded-md border bg-card p-3 text-xs">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="font-semibold text-foreground" style={eventTone[log.event_type] ?? undefined}>
              {eventLabel[log.event_type] ?? log.event_type.replace(/^agenda\./, '').replaceAll('_', ' ')}
            </span>
            <span className="text-muted-foreground text-[10px]">
              {new Date(log.occurred_at).toLocaleTimeString()}
            </span>
          </div>
          <p className="text-muted-foreground leading-relaxed">{log.message}</p>
          {(log.raw_payload?.durationMs || log.raw_payload?.model || log.raw_payload?.runDelaySeconds != null || log.raw_payload?.outputSource || log.raw_payload?.artifactName) ? (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              {log.raw_payload?.durationMs ? (
                <span>Duration: {Math.round(Number(log.raw_payload.durationMs) / 1000)}s</span>
              ) : null}
              {log.raw_payload?.runDelaySeconds != null ? (
                <span>Delay: {Number(log.raw_payload.runDelaySeconds)}s</span>
              ) : null}
              {log.raw_payload?.model ? <span>Model: {String(log.raw_payload.model)}</span> : null}
              {log.raw_payload?.outputSource ? <span>Output source: {beautifyOutputSource(String(log.raw_payload.outputSource))}</span> : null}
              {log.raw_payload?.artifactName ? <span>Artifact: {String(log.raw_payload.artifactName)}</span> : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function parseAgentOutput(outputPayload: string | Record<string, unknown> | null): { cleaned: string; outputSource: string } | null {
  if (!outputPayload) return null;
  let outputText = "";
  let outputSource = "";
  // output_payload is jsonb — postgres driver may return a parsed object or a string
  const raw = outputPayload;
  if (typeof raw === "object" && raw !== null) {
    // Already parsed object from jsonb
    outputText = typeof (raw as Record<string, unknown>).output === "string"
      ? (raw as Record<string, unknown>).output as string
      : JSON.stringify(raw);
    outputSource = typeof (raw as Record<string, unknown>).outputSource === "string"
      ? (raw as Record<string, unknown>).outputSource as string
      : "";
  } else if (typeof raw === "string") {
    outputText = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && typeof parsed.output === "string") {
        outputText = parsed.output;
        outputSource = typeof parsed.outputSource === "string" ? parsed.outputSource : "";
      } else if (typeof parsed === "string") {
        outputText = parsed;
      }
    } catch { /* keep raw string */ }
  }
  const cleaned = outputText.replace(/\n*>\s*`Agent:.*`$/, "").trim();
  if (!cleaned) return null;
  return { cleaned, outputSource };
}

function sanitizePromptForDisplay(promptText: string | null): string | null {
  if (!promptText) return null;
  // Only strip the internal AGENDA_MARKER line — keep execution/output rules visible.
  const text = String(promptText).replace(/^# AGENDA_MARKER:occurrence_id=[^\n]+\n\n?/m, "").trim();
  return text || null;
}

function AgentOutput({ outputPayload }: { outputPayload: string | Record<string, unknown> | null }) {
  const parsed = parseAgentOutput(outputPayload);
  if (!parsed) return null;

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-muted/40 p-4 flex flex-col gap-2 break-words [overflow-wrap:anywhere]">
      {parsed.outputSource ? (
        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground break-words [overflow-wrap:anywhere]">
          Output source: {beautifyOutputSource(parsed.outputSource)}
        </p>
      ) : null}
      <div className="min-w-0 break-words [overflow-wrap:anywhere]">
        {renderMarkdown(parsed.cleaned)}
      </div>
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(mimeType: string | undefined) {
  if (!mimeType) return <IconFile className="size-5 text-primary" />;
  if (mimeType.startsWith("image/")) return <IconPhoto className="size-5 text-primary" />;
  if (mimeType === "application/pdf") return <span className="text-[11px] font-bold text-primary">PDF</span>;
  if (mimeType.startsWith("text/")) return <span className="text-[11px] font-bold text-primary">TXT</span>;
  return <IconFile className="size-5 text-primary" />;
}

function ArtifactImagePreview({ stepId, file }: { stepId: string; file: ArtifactFile }) {
  const [failed, setFailed] = useState(false);
  const src = `/api/agenda/artifacts/${stepId}/${encodeURIComponent(file.name)}`;

  return (
    <div className="rounded-lg border bg-muted/10 p-3">
      <div className="flex flex-col gap-3">
        <p className="text-[10px] text-muted-foreground font-medium leading-none">{file.name}</p>
        <div className="rounded-md overflow-hidden bg-background/60">
          {failed ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground text-xs">
              <IconPhoto className="size-4" />
              <span>Preview unavailable</span>
              <a href={src} download={file.name} className="underline hover:text-foreground">
                download instead
              </a>
            </div>
          ) : (
            // Use plain <img> + unoptimized semantics: the Next image optimizer
            // proxies /_next/image → the artifact API, which in dev frequently
            // 500s or chokes on dynamic bytes. Serving the raw API response via
            // <img> is deterministic and matches the rest of the download flow.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={file.name}
              loading="lazy"
              decoding="async"
              onError={() => setFailed(true)}
              className="max-h-[300px] w-full object-contain"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ArtifactFiles({ stepId, files }: { stepId: string; files: ArtifactFile[] }) {
  if (!files || files.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 mt-3">
      <p className="text-xs font-semibold text-foreground/80 flex items-center gap-1.5">
        <IconFile className="size-3 text-primary" />
        Artifacts ({files.length})
      </p>

      {/* File list */}
      <div className="grid grid-cols-1 gap-2">
        {files.map((file) => {
          const downloadUrl = `/api/agenda/artifacts/${stepId}/${encodeURIComponent(file.name)}`;

          return (
            <div
              key={file.name}
              className="flex items-center gap-3 rounded-lg border bg-muted/20 p-3 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-center justify-center size-10 rounded-lg bg-primary/10 shrink-0">
                {fileIcon(file.mimeType)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {file.mimeType} · {formatBytes(file.size)}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={downloadUrl}
                  download={file.name}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs cursor-pointer">
                    <IconDownload className="size-3" />
                    Download
                  </Button>
                </a>
              </div>
            </div>
          );
        })}
      </div>

      {/* Inline image previews only — PDFs open via download, no blank iframe blocks */}
      {files.some((f) => f.mimeType?.startsWith("image/")) && (
        <div className="flex flex-col gap-2 mt-1">
          {files.filter((f) => f.mimeType?.startsWith("image/")).map((file) => (
            <ArtifactImagePreview key={`preview-${file.name}`} stepId={stepId} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}

function humanRecurrence(recurrence: string) {
  if (!recurrence || recurrence === "none") return null;
  const map: Record<string, string> = { daily: "Every day", weekly: "Every week", monthly: "Every month" };
  return map[recurrence] ?? recurrence;
}

function getScheduleDisplay(event: AgendaEventSummary): string {
  if (!event.startDate) return "Not set";
  const time = event.startTime || "";
  const tz = event.startTime ? ` ${getTimezoneAbbr(event.timezone)}` : "";
  const main = `${event.startDate} ${time}${tz}`.trim();
  if (event.endDate) return `${main} to ${event.endDate}`;
  return main;
}

export function AgendaDetailsSheet({ open, event, agents, onClose, onEdit, onCopy, onRetry, onDelete }: Props) {
  const [activeTab, setActiveTab] = useState("overview");
  const [occurrences, setOccurrences] = useState<{ id: string; scheduled_for: string; status: string; latest_attempt_no: number; rendered_prompt?: string | null }[]>([]);
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<RunAttempt[]>([]);
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [forceRetryDialogOpen, setForceRetryDialogOpen] = useState(false);
  // Local override for occurrence status after retry (optimistic UI update)
  const [occStatusOverride, setOccStatusOverride] = useState<{ id: string; status: string } | null>(null);

  const isRecurring = event ? (event.recurrence && event.recurrence !== "none") : false;

  // Fetch occurrences on mount (component is keyed, so this runs fresh each time)
  useEffect(() => {
    if (!open || !event?.id) return;
    const controller = new AbortController();
    setSelectedOccurrenceId(null);

    const recurring = event.recurrence && event.recurrence !== "none";

    void (async () => {
      try {
        const res = await fetch(`/api/agenda/events/${event.id}`, {
          cache: "reload",
          signal: controller.signal,
        });
        const json = await res.json();
        if (json.ok && !controller.signal.aborted) {
          setOccurrences(json.occurrences ?? []);
          // Only select the specific occurrence for the clicked date — never cross-pollinate
          const occs = json.occurrences ?? [];
          if (event.occurrenceId && occs.some((o: { id: string }) => o.id === event.occurrenceId)) {
            setSelectedOccurrenceId(event.occurrenceId);
          } else if (!recurring && occs.length > 0) {
            // Non-recurring: safe to pick the only occurrence
            setSelectedOccurrenceId(occs[0].id);
          } else {
            setSelectedOccurrenceId(null);
          }
          // Recurring with no matching occurrence → leave null (no run yet for this date)
        }
      } catch { /* ignore aborts + fetch errors */ }
    })();

    return () => controller.abort();
  }, [open, event?.id, event?.occurrenceId, event?.recurrence]);

  useEffect(() => {
    if (!selectedOccurrenceId || !event?.id) return;
    setLoadingRuns(true);
    setAttempts([]);
    setSteps([]);
    setSelectedAttemptId(null);

    void (async () => {
      try {
        const res = await fetch(
          `/api/agenda/events/${event.id}/occurrences/${selectedOccurrenceId}/runs`,
          { cache: "reload" }
        );
        const json = await res.json();
        if (json.ok) {
          setAttempts(json.attempts ?? []);
          setSteps(json.steps ?? []);
          if (json.attempts?.length > 0) setSelectedAttemptId(json.attempts[json.attempts.length - 1].id);
        }
      } catch { /* ignore */ }
      finally { setLoadingRuns(false); }
    })();
  }, [selectedOccurrenceId, event?.id]);

  if (!event) return null;

  const resolvedAgentName = (() => {
    if (event.agentName) return event.agentName;
    if (event.agentId) {
      const found = agents?.find((a) => a.id === event.agentId);
      if (found?.name) return found.name;
    }
    return "System default";
  })();

  const selectedOccurrence = occurrences.find((o) => o.id === selectedOccurrenceId);
  // Override the displayed status if a retry was just triggered (optimistic update).
  // This fixes bug #1 where retrying a done event still shows "done" in the status badge.
  const displayedOccurrence = selectedOccurrence
    ? occStatusOverride?.id === selectedOccurrence.id
      ? { ...selectedOccurrence, status: occStatusOverride.status }
      : selectedOccurrence
    : null;
  const selectedAttempt = attempts.find((a) => a.id === selectedAttemptId);
  const attemptSteps = steps.filter((s) => s.run_attempt_id === selectedAttemptId);

  // Derive the artifact folder from the first step that produced files.
  // All files for an occurrence share the same parent dir (runtime-artifacts/agenda/<eventId>/occurrences/<occId>/artifacts).
  const outputFolder = (() => {
    for (const step of attemptSteps) {
      const raw = step.artifact_payload;
      let payload: { files?: ArtifactFile[] } | null = null;
      if (typeof raw === "string") { try { payload = JSON.parse(raw); } catch { payload = null; } }
      else if (typeof raw === "object" && raw !== null) { payload = raw as { files: ArtifactFile[] }; }
      const firstPath = payload?.files?.[0]?.path;
      if (firstPath) {
        const idx = Math.max(firstPath.lastIndexOf("/"), firstPath.lastIndexOf("\\"));
        if (idx > 0) return firstPath.slice(0, idx);
      }
    }
    return null;
  })();

  const copyToClipboard = (value: string, label: string) => {
    void navigator.clipboard.writeText(value).then(
      () => toast.success(`${label} copied`),
      () => toast.error(`Failed to copy ${label.toLowerCase()}`),
    );
  };

  const taskSummary = ((event.request ?? event.freePrompt) || "").trim()
    ? ((event.request ?? event.freePrompt) || "").trim()
    : event.processNames.length > 0
      ? `Runs ${event.processNames.join(" + ")}`
      : "No task specified";

  const recurrenceLabel = humanRecurrence(event.recurrence);
  const overviewCardClassName = "h-full flex flex-col bg-gradient-to-t from-primary/12 to-card shadow-sm";
  const overviewCardFooterClassName = "mt-auto flex-col items-start gap-1 text-sm";

  return (
    <TooltipProvider delayDuration={200}>
      <Sheet open={open && !deleteDialogOpen} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
        <SheetContent className="w-full sm:max-w-[640px] overflow-y-auto p-0 flex flex-col" showCloseButton={false}>
          {/* ── Header ── */}
          <div className="p-6 pb-4">
            <SheetHeader className="p-0 pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-2 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <SheetTitle className="text-xl leading-tight">{event.title}</SheetTitle>
                    <Tip text={event.status === "active"
                      ? "This event is active and will execute on schedule"
                      : "This event is a draft and will not execute until activated"}>
                      <Badge
                        variant="outline"
                        className={[
                          "text-[10px] uppercase tracking-wider cursor-default",
                          event.status === "active"
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "border-muted-foreground/30 text-muted-foreground",
                        ].join(" ")}
                      >
                        {event.status === "active" && (
                          <span className="size-1.5 rounded-full bg-emerald-500 mr-1 shrink-0" />
                        )}
                        {event.status}
                      </Badge>
                    </Tip>
                    {isRecurring && (
                      <Tip text="This event repeats on a schedule (daily, weekly, or monthly)">
                        <Badge
                          variant="outline"
                          className="text-[10px] uppercase tracking-wider gap-1 border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400 cursor-default"
                        >
                          <IconRepeat className="size-2.5" />
                          Recurring
                        </Badge>
                      </Tip>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" className="h-8 w-8 p-0 cursor-pointer">
                        <IconDotsVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem
                        className={`gap-2 ${selectedOccurrence?.status === "running" ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                        disabled={selectedOccurrence?.status === "running"}
                        onClick={() => { if (selectedOccurrence?.status !== "running") onEdit(event); }}
                      >
                        {selectedOccurrence?.status === "running" ? <IconLock className="size-3.5" /> : <IconPencil className="size-3.5" />}
                        {selectedOccurrence?.status === "running" ? "Edit (running)" : "Edit"}
                      </DropdownMenuItem>
                      {onCopy && (
                        <DropdownMenuItem className="gap-2 cursor-pointer" onClick={() => { onCopy(event); onClose(); }}>
                          <IconCopy className="size-3.5" />
                          Duplicate
                        </DropdownMenuItem>
                      )}
                      {displayedOccurrence && selectedOccurrenceId && (() => {
                        const canRetry = ["running", "needs_retry", "failed", "queued", "scheduled", "succeeded", "cancelled"].includes(displayedOccurrence.status);
                        return (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className={`gap-2 ${canRetry ? "cursor-pointer text-amber-600 dark:text-amber-400" : "opacity-50 cursor-not-allowed"}`}
                              disabled={!canRetry}
                              onClick={() => {
                                if (!canRetry) return;
                                if (["succeeded", "cancelled"].includes(displayedOccurrence.status)) {
                                  setForceRetryDialogOpen(true);
                                  return;
                                }
                                onRetry(selectedOccurrenceId, { force: displayedOccurrence.status === "running" });
                                setOccStatusOverride({ id: selectedOccurrenceId, status: "queued" });
                              }}
                            >
                              <IconRefresh className="size-3.5" />
                              {!canRetry ? "Retry (completed)" : displayedOccurrence.status === "running" ? "Force Retry" : ["succeeded", "cancelled"].includes(displayedOccurrence.status) ? "Force Retry" : "Retry"}
                            </DropdownMenuItem>
                          </>
                        );
                      })()}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        className="gap-2 cursor-pointer"
                        onClick={() => setDeleteDialogOpen(true)}
                      >
                        <IconX className="size-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {/* Close button — same style as the 3-dots menu trigger, placed to its right */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 w-8 p-0 cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => onClose()}
                  >
                    <IconX className="size-4" />
                  </Button>
                </div>
              </div>
            </SheetHeader>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed line-clamp-3">
              {taskSummary}
            </p>
          </div>

          <Separator />

          {/* ── Tabs ── */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
            <div className="px-6 pt-3">
              <TabsList className="grid w-full grid-cols-3 h-9">
                <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
                <TabsTrigger value="output" className="text-xs">Output</TabsTrigger>
                <TabsTrigger value="logs" className="text-xs">Logs</TabsTrigger>
              </TabsList>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* ── Overview ── */}
              <TabsContent value="overview" className="mt-0">
                <div className="dark:*:data-[slot=card]:bg-card grid grid-cols-2 gap-3">
                  {/* Schedule */}
                  <Card data-slot="card" className={overviewCardClassName}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardDescription className="m-0">Schedule</CardDescription>
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          <IconCalendar className="size-3" />
                          {event.startDate ?? "Not set"}
                        </Badge>
                      </div>
                      <CardTitle className="text-sm font-semibold tabular-nums">
                        {getScheduleDisplay(event)}
                      </CardTitle>
                    </CardHeader>
                    <CardFooter className={overviewCardFooterClassName}>
                      <div className="text-muted-foreground text-xs">{event.timezone}</div>
                      {(event.endDate || event.endTime) && (
                        <div className="text-muted-foreground text-xs">
                          Until {event.endDate} {event.endTime}
                        </div>
                      )}
                    </CardFooter>
                  </Card>

                  {/* Agent */}
                  <Card data-slot="card" className={overviewCardClassName}>
                    <CardHeader>
                      <CardDescription>Agent</CardDescription>
                      <CardTitle className="text-lg font-semibold truncate">
                        {resolvedAgentName}
                      </CardTitle>
                      <CardAction>
                        <Badge variant="outline">
                          <IconUser className="size-3" />
                          Assigned
                        </Badge>
                      </CardAction>
                    </CardHeader>
                    <CardFooter className={overviewCardFooterClassName}>
                      {event.agentId ? (
                        <div className="text-muted-foreground text-xs truncate max-w-full">{event.agentId}</div>
                      ) : (
                        <div className="text-muted-foreground text-xs">Using system default</div>
                      )}
                    </CardFooter>
                  </Card>

                  {/* Session Mode */}
                  <Card data-slot="card" className={overviewCardClassName}>
                    <CardHeader>
                      <CardDescription>Execution mode</CardDescription>
                      <CardTitle className="text-lg font-semibold">
                        {event.sessionTarget === "main" ? "Main session" : "Isolated"}
                      </CardTitle>
                      <CardAction>
                        <Badge variant="outline">
                          {event.sessionTarget === "main" ? "Persistent" : "Fresh each run"}
                        </Badge>
                      </CardAction>
                    </CardHeader>
                    <CardFooter className={overviewCardFooterClassName}>
                      <div className="text-muted-foreground text-xs">
                        {event.sessionTarget === "main"
                          ? "Runs in your persistent main session — full memory and context"
                          : "Runs in a fresh isolated session — no shared state"}
                      </div>
                    </CardFooter>
                  </Card>

                  {/* Created At */}
                  <Card data-slot="card" className={overviewCardClassName}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardDescription className="m-0">Created At</CardDescription>
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          <IconCalendarClock className="size-3" />
                          Created
                        </Badge>
                      </div>
                      <CardTitle className="text-sm font-semibold tabular-nums">
                        {event.createdAt ? formatTime(event.createdAt, event.timezone) : "—"}
                      </CardTitle>
                    </CardHeader>
                    <CardFooter className={overviewCardFooterClassName} />
                  </Card>

                  {/* Model */}
                  {event.sessionTarget !== "main" && (
                    <Card data-slot="card" className={overviewCardClassName}>
                      <CardHeader>
                        <CardDescription>Model</CardDescription>
                        <CardTitle className="text-sm font-semibold truncate">
                          {event.modelOverride || "Agent default"}
                        </CardTitle>
                        <CardAction>
                          <Badge variant="outline">
                            <IconBrain className="size-3" />
                            {event.modelOverride ? "Override" : "Default"}
                          </Badge>
                        </CardAction>
                      </CardHeader>
                      <CardFooter className={overviewCardFooterClassName}>
                        <div className="text-muted-foreground text-xs">
                          Runs with this event’s isolated-session model selection.
                        </div>
                      </CardFooter>
                    </Card>
                  )}

                  {/* Status — merged: shows occurrence + attempt status, attempt no, time, and retry action */}
                  {displayedOccurrence && (
                    <Card
                      data-slot="card"
                      className={[
                        overviewCardClassName,
                        (selectedAttempt?.status ?? displayedOccurrence.status) === "failed"
                          ? "border-red-200 dark:border-red-900"
                          : (selectedAttempt?.status ?? displayedOccurrence.status) === "running"
                            ? "border-blue-200 dark:border-blue-900"
                            : "",
                      ].join(" ")}
                    >
                      <CardHeader>
                        <CardDescription>
                          {isRecurring ? "Occurrence Status" : "Status"}
                        </CardDescription>
                        <CardTitle className="text-lg font-semibold flex items-center gap-2 flex-wrap">
                          {selectedAttempt ? (
                            <ResultBadge status={selectedAttempt.status} />
                          ) : (
                            <ResultBadge status={displayedOccurrence.status} />
                          )}
                        </CardTitle>
                        <CardAction>
                          <Badge variant="outline">
                            <IconClock className="size-3" />
                            {selectedAttempt
                              ? `Attempt ${selectedAttempt.attempt_no}`
                              : displayedOccurrence.latest_attempt_no > 0
                                ? `Attempt ${displayedOccurrence.latest_attempt_no}`
                                : "Not started"}
                          </Badge>
                        </CardAction>
                      </CardHeader>
                      <CardFooter className="mt-auto flex-col items-start gap-1.5 text-sm">
                        {selectedAttempt?.started_at ? (
                          <div className="text-muted-foreground text-xs">
                            {formatTime(selectedAttempt.started_at, event.timezone)}
                            {selectedAttempt.finished_at && (
                              <>
                                {" "}({formatDuration(selectedAttempt.started_at, selectedAttempt.finished_at)})
                              </>
                            )}
                          </div>
                        ) : displayedOccurrence.scheduled_for ? (
                          <div className="text-muted-foreground text-xs">
                            Scheduled for {formatTime(displayedOccurrence.scheduled_for, event.timezone)}
                          </div>
                        ) : null}
                        {["failed", "needs_retry", "succeeded", "cancelled"].includes(displayedOccurrence.status) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 h-7 text-xs mt-0.5 cursor-pointer"
                            onClick={() => {
                              if (["succeeded", "cancelled"].includes(displayedOccurrence.status)) {
                                setForceRetryDialogOpen(true);
                                return;
                              }
                              onRetry(selectedOccurrenceId!);
                              setOccStatusOverride({ id: selectedOccurrenceId as string, status: "queued" });
                            }}
                          >
                            <IconRefresh className="size-3" />
                            {["succeeded", "cancelled"].includes(displayedOccurrence.status) ? "Force Retry" : "Retry"}
                          </Button>
                        )}
                      </CardFooter>
                    </Card>
                  )}

                  {/* Recurrence */}
                  {isRecurring && (
                    <Card data-slot="card" className={overviewCardClassName}>
                      <CardHeader>
                        <CardDescription>Recurrence</CardDescription>
                        <CardTitle className="text-sm font-semibold">
                          {recurrenceLabel}
                        </CardTitle>
                        <CardAction>
                          <Badge variant="outline">
                            <IconRepeat className="size-3" />
                            Active
                          </Badge>
                        </CardAction>
                      </CardHeader>
                      <CardFooter className={overviewCardFooterClassName} />
                    </Card>
                  )}

                  {/* Duration */}
                  {selectedAttempt?.started_at && (
                    <Card data-slot="card" className={overviewCardClassName}>
                      <CardHeader>
                        <CardDescription>Duration</CardDescription>
                        <CardTitle className="text-lg font-semibold tabular-nums">
                          {selectedAttempt.finished_at ? (formatDuration(selectedAttempt.started_at, selectedAttempt.finished_at) ?? "—") : <LiveDuration startedAt={selectedAttempt.started_at} finishedAt={selectedAttempt.finished_at} />}
                        </CardTitle>
                        <CardAction>
                          <Badge variant="outline" className={
                            !selectedAttempt.finished_at
                              ? "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          }>
                            <IconClock className="size-3" />
                            {selectedAttempt.finished_at ? "Completed" : "In progress"}
                          </Badge>
                        </CardAction>
                      </CardHeader>
                      <CardFooter className={overviewCardFooterClassName}>
                        <div className="text-muted-foreground text-xs">
                          Started {formatTime(selectedAttempt.started_at, event.timezone)}
                        </div>
                        {selectedAttempt.finished_at && (
                          <div className="text-muted-foreground text-xs">
                            Finished {formatTime(selectedAttempt.finished_at, event.timezone)}
                          </div>
                        )}
                      </CardFooter>
                    </Card>
                  )}

                  {event.processNames.length > 0 && (
                    <Card data-slot="card" className={overviewCardClassName}>
                      <CardHeader>
                        <CardDescription>Attached Processes</CardDescription>
                        <CardTitle className="text-lg font-semibold tabular-nums">
                          {event.processNames.length}
                        </CardTitle>
                        <CardAction>
                          <Badge variant="outline">
                            <IconBrain className="size-3" />
                            Processes
                          </Badge>
                        </CardAction>
                      </CardHeader>
                      <CardFooter className="mt-auto flex-col items-start gap-1.5 text-sm">
                        <div className="flex flex-wrap gap-1.5">
                          {event.processNames.map((name) => (
                            <Badge key={name} variant="secondary" className="text-xs">
                              {name}
                            </Badge>
                          ))}
                        </div>
                      </CardFooter>
                    </Card>
                  )}

                  {/* Identifiers — event ID and, for recurring series, the occurrence ID */}
                  <Card data-slot="card" className={overviewCardClassName}>
                    <CardHeader>
                      <CardDescription>Identifiers</CardDescription>
                      <CardTitle className="text-sm font-semibold truncate">
                        {isRecurring && selectedOccurrenceId ? "Occurrence" : "Event"}
                      </CardTitle>
                      <CardAction>
                        <Badge variant="outline">
                          <IconHash className="size-3" />
                          ID
                        </Badge>
                      </CardAction>
                    </CardHeader>
                    <CardFooter className="mt-auto flex-col items-start gap-2 text-sm">
                      <div className="flex items-center gap-1.5 w-full min-w-0">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-14 shrink-0">Event</span>
                        <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-foreground/80">{event.id}</code>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 shrink-0 cursor-pointer"
                          onClick={() => copyToClipboard(event.id, "Event ID")}
                          title="Copy event ID"
                        >
                          <IconCopy className="size-3" />
                        </Button>
                      </div>
                      {isRecurring && selectedOccurrenceId && (
                        <div className="flex items-center gap-1.5 w-full min-w-0">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-14 shrink-0">Occ.</span>
                          <code className="flex-1 min-w-0 truncate text-[11px] font-mono text-foreground/80">{selectedOccurrenceId}</code>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 shrink-0 cursor-pointer"
                            onClick={() => copyToClipboard(selectedOccurrenceId, "Occurrence ID")}
                            title="Copy occurrence ID"
                          >
                            <IconCopy className="size-3" />
                          </Button>
                        </div>
                      )}
                    </CardFooter>
                  </Card>

                  {/* Output folder — path where this occurrence's artifacts are saved on disk */}
                  {outputFolder && (() => {
                    const normalized = outputFolder.replace(/\\/g, "/");
                    const rel = normalized.replace(/^\/home\/clawdbot\/\.openclaw\/?/, "/");
                    const fmPath = rel.startsWith("/") ? rel : `/${rel}`;
                    const fmHref = `/file-manager?path=${encodeURIComponent(fmPath)}`;
                    return (
                      <Card data-slot="card" className={overviewCardClassName}>
                        <CardHeader>
                          <CardDescription>Output folder</CardDescription>
                          <CardTitle className="text-sm font-semibold truncate" title={outputFolder}>
                            {outputFolder.split(/[\\/]/).pop() || outputFolder}
                          </CardTitle>
                          <CardAction>
                            <Badge variant="outline">
                              <IconFolder className="size-3" />
                              Artifacts
                            </Badge>
                          </CardAction>
                        </CardHeader>
                        <CardFooter className="mt-auto flex-col items-start gap-2 text-sm">
                          <code className="w-full truncate text-[11px] font-mono text-muted-foreground" title={outputFolder}>
                            {outputFolder}
                          </code>
                          <Button
                            asChild
                            size="sm"
                            variant="outline"
                            className="gap-1.5 h-7 text-xs cursor-pointer"
                          >
                            <Link href={fmHref}>
                              <IconFolderOpen className="size-3" />
                              Open in file manager
                            </Link>
                          </Button>
                        </CardFooter>
                      </Card>
                    );
                  })()}
                </div>
              </TabsContent>

              {/* ── Output ── */}
              <TabsContent value="output" className="flex flex-col gap-3 mt-0">
                {loadingRuns ? (
                  <div className="flex flex-col gap-3">
                    {[1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
                  </div>
                ) : !selectedAttempt ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <IconFileText className="size-10 text-muted-foreground/50 mb-3" />
                    <p className="text-sm text-muted-foreground">No output yet — event hasn&apos;t run.</p>
                  </div>
                ) : attemptSteps.length === 0 ? (
                  <div className="flex flex-col gap-4">
                    {selectedOccurrence?.rendered_prompt && (
                      <>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Input sent to agent</p>
                        <div className="rounded-lg border bg-muted/40 p-4">
                          <p className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed font-mono max-h-[400px] overflow-y-auto">
                            {sanitizePromptForDisplay(selectedOccurrence.rendered_prompt) ?? selectedOccurrence.rendered_prompt}
                          </p>
                        </div>
                      </>
                    )}
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <IconFileText className="size-10 text-muted-foreground/50 mb-3" />
                      <p className="text-sm text-muted-foreground">No output recorded yet.</p>
                      {!selectedOccurrence?.rendered_prompt && (
                        <p className="text-xs text-muted-foreground/60 mt-1">The prompt will appear here once the occurrence is picked up.</p>
                      )}
                    </div>
                  </div>
                ) : (
                  // Deduplicate: group steps by step_order, show only the last one per group
                  // (auto-retries within the same attempt insert duplicate step_order rows)
                  (() => {
                    const groupedByOrder = new Map<number, RunStep[]>();
                    for (const s of attemptSteps) {
                      const arr = groupedByOrder.get(s.step_order) ?? [];
                      arr.push(s);
                      groupedByOrder.set(s.step_order, arr);
                    }
                    const deduped = [...groupedByOrder.entries()]
                      .sort(([a], [b]) => a - b)
                      .map(([, group]) => ({ step: group[group.length - 1], totalAttempts: group.length }));
                    return deduped;
                  })().map(({ step, totalAttempts }) => {
                    // Extract the prompt/instruction from input_payload
                    // bridge-logger writes { prompt: "..." } for agenda runs
                    // process-based runs write { instruction: "..." }
                    let promptText: string | null = null;
                    if (step.input_payload) {
                      const raw = step.input_payload;
                      const payload = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
                      if (payload && typeof payload === "object") {
                        const p = payload as Record<string, unknown>;
                        promptText = (typeof p.prompt === "string" ? p.prompt : null)
                          ?? (typeof p.instruction === "string" ? p.instruction : null)
                          ?? null;
                      }
                    }
                    // Fall back to step_instruction from process definition
                    if (!promptText && step.step_instruction) {
                      promptText = step.step_instruction;
                    }
                    promptText = sanitizePromptForDisplay(promptText);

                    const stepLabel = step.process_name
                      ? `Step ${step.step_order + 1}: ${step.step_title || step.process_name}`
                      : "Request";

                    return (
                      <Card
                        key={step.id}
                        data-slot="card"
                        className="bg-gradient-to-t from-primary/12 to-card shadow-xs"
                      >
                        {/* Step header — title + status + retry count */}
                        <CardHeader>
                          <CardTitle className="text-base font-semibold flex items-center gap-2">
                            {stepLabel}
                            {totalAttempts > 1 && (
                              <Badge variant="secondary" className="text-[10px] font-medium">
                                {totalAttempts} attempt{totalAttempts === 1 ? "" : "s"}
                              </Badge>
                            )}
                          </CardTitle>
                          <CardAction>
                            <ResultBadge status={step.status} />
                          </CardAction>
                        </CardHeader>

                        <CardContent className="flex flex-col gap-3">
                          {/* Step metadata — stacked vertically */}
                          <div className="flex flex-col gap-1.5 rounded-lg bg-muted/30 p-3">
                            {step.process_name && (
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-16 shrink-0">Process</span>
                                <span className="text-xs text-foreground">{step.process_name}</span>
                              </div>
                            )}
                            {step.step_title && step.step_title !== step.process_name && (
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-16 shrink-0">Title</span>
                                <span className="text-xs text-foreground">{step.step_title}</span>
                              </div>
                            )}
                            {step.skill_key && (
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-16 shrink-0">Skill</span>
                                <Badge variant="secondary" className="text-[10px]">{step.skill_key}</Badge>
                              </div>
                            )}
                            {step.agent_id && (
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-16 shrink-0">Agent</span>
                                <span className="text-xs font-mono text-foreground/80">{step.agent_id}</span>
                              </div>
                            )}
                            {step.step_instruction && !promptText && (
                              <div className="flex items-start gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-16 shrink-0 pt-0.5">Desc</span>
                                <span className="text-xs text-foreground/80 leading-relaxed">{step.step_instruction.length > 300 ? step.step_instruction.slice(0, 300) + "…" : step.step_instruction}</span>
                              </div>
                            )}
                            {(step.started_at || step.finished_at) && (
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground w-16 shrink-0">Time</span>
                                <span className="text-[10px] text-muted-foreground">
                                  {step.started_at ? formatTime(step.started_at, event.timezone) : "—"}
                                  {step.finished_at ? ` → ${formatTime(step.finished_at, event.timezone)}` : ""}
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Step Request — same label + content pattern as Output */}
                          {promptText && (
                            <>
                              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                Step request
                              </p>
                              <div className="min-w-0 overflow-hidden rounded-lg border bg-muted/40 p-4">
                                <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed font-mono max-h-[400px] overflow-y-auto">
                                  {promptText}
                                </p>
                              </div>
                            </>
                          )}

                          {/* Output */}
                          {step.error_message && (
                            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm text-red-600">
                              <p className="text-[10px] font-bold uppercase tracking-wider text-red-700 dark:text-red-400 mb-1">Error</p>
                              {step.error_message}
                            </div>
                          )}
                          {(() => {
                            const parsedOutput = parseAgentOutput(step.output_payload ?? null);
                            if (parsedOutput) {
                              return (
                                <>
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                    {step.status === "failed" ? "Output (failed run)" : "Output"}
                                  </p>
                                  <AgentOutput outputPayload={step.output_payload} />
                                </>
                              );
                            }
                            return !step.error_message ? (
                              <p className="text-sm text-muted-foreground">No output available</p>
                            ) : null;
                          })()}

                          {/* Artifacts */}
                          {(() => {
                            let ap: { files: ArtifactFile[] } | null = null;
                            const raw = step.artifact_payload;
                            if (typeof raw === "string") { try { ap = JSON.parse(raw); } catch { ap = null; } }
                            else if (typeof raw === "object" && raw !== null) { ap = raw as { files: ArtifactFile[] }; }
                            return ap?.files && ap.files.length > 0 ? <ArtifactFiles stepId={step.id} files={ap.files} /> : null;
                          })()}
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </TabsContent>

              {/* ── Logs ── */}
              <TabsContent value="logs" className="flex flex-col gap-2 mt-0">
                <AgendaOccurrenceLogs occurrenceId={selectedOccurrenceId} />
              </TabsContent>
            </div>
          </Tabs>
        </SheetContent>
      </Sheet>

      <AlertDialog open={forceRetryDialogOpen} onOpenChange={(isOpen) => { setForceRetryDialogOpen(isOpen); }}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <IconRefresh className="size-4" />
              Force retry this completed run?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm">
              This occurrence already executed. Force Retry will clean up prior run artifacts where possible and execute it again. Use this only when you intentionally want to re-run completed work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (selectedOccurrenceId) onRetry(selectedOccurrenceId, { force: true });
                setForceRetryDialogOpen(false);
              }}
              className="bg-amber-600 text-white hover:bg-amber-700 cursor-pointer"
            >
              Force Retry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation — uses [&>div]:z-[60] to lift both overlay + content above the Sheet */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={(isOpen) => { setDeleteDialogOpen(isOpen); }}>
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <IconX className="size-4" />
              Delete this event?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm">
              {isRecurring
                ? `"${event.title}" is a recurring event. Choose what to delete.`
                : `This will permanently delete "${event.title}" and its run history. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {isRecurring ? (
            <div className="flex flex-col gap-2">
              <Button
                variant="outline"
                className="h-auto px-4 py-3 justify-start text-left gap-3 cursor-pointer border-destructive/30 bg-destructive/5 hover:bg-destructive/10"
                onClick={() => {
                  // Cancel just this occurrence
                  if (selectedOccurrenceId) {
                    void fetch(`/api/agenda/events/${event.id}/occurrences/${selectedOccurrenceId}`, { method: "DELETE" });
                  }
                  setDeleteDialogOpen(false);
                  onClose();
                  document.dispatchEvent(new CustomEvent("agenda-refresh"));
                }}
              >
                <IconCalendar className="size-4 text-destructive shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm text-foreground">Only this occurrence</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">Cancel this one run only. The rest of the series continues.</p>
                </div>
              </Button>
              <Button
                variant="outline"
                className="h-auto px-4 py-3 justify-start text-left gap-3 cursor-pointer border-destructive/30 bg-destructive/5 hover:bg-destructive/10"
                onClick={() => { onDelete(event.id); setDeleteDialogOpen(false); onClose(); }}
              >
                <IconX className="size-4 text-destructive shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm text-destructive">Delete all future events</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">Stop the entire series and cancel all future runs. Past runs are kept for history.</p>
                </div>
              </Button>
              <AlertDialogFooter className="mt-1">
                <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
              </AlertDialogFooter>
            </div>
          ) : (
            <AlertDialogFooter>
              <AlertDialogCancel className="cursor-pointer">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => { onDelete(event.id); setDeleteDialogOpen(false); onClose(); }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 cursor-pointer"
              >
                Delete event
              </AlertDialogAction>
            </AlertDialogFooter>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
