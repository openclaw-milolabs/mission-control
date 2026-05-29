"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActivityIcon,
  ArrowDownIcon,
  CheckCircle2Icon,
  AlertTriangleIcon,
  XCircleIcon,
  InfoIcon,
  BotIcon,
  UserIcon,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

export type LiveLog = {
  id: string;
  ticket_id?: string;
  ticket_title?: string;
  source?: string;
  event?: string;
  details?: string;
  level?: string;
  actor_name?: string | null;
  actor_email?: string | null;
  occurred_at?: string;
};

type Props = {
  activity: LiveLog[];
  loading: boolean;
  onTicketClick: (ticketId: string) => void;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return "";
  const diff = Math.max(0, now - then);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const LEVEL_CONFIG: Record<string, {
  border: string;
  bg: string;
  text: string;
  icon: React.ComponentType<{ className?: string }>;
}> = {
  success: { border: "border-l-emerald-500", bg: "bg-emerald-500/8", text: "text-emerald-600 dark:text-emerald-400", icon: CheckCircle2Icon },
  error: { border: "border-l-red-500", bg: "bg-red-500/8", text: "text-red-600 dark:text-red-400", icon: XCircleIcon },
  warning: { border: "border-l-amber-500", bg: "bg-amber-500/8", text: "text-amber-600 dark:text-amber-400", icon: AlertTriangleIcon },
  info: { border: "border-l-blue-500", bg: "bg-blue-500/8", text: "text-blue-600 dark:text-blue-400", icon: InfoIcon },
};

// ── Component ────────────────────────────────────────────────────────────────

export function BoardActivityFeed({ activity, loading, onTicketClick }: Props) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(activity.length);

  // Auto-scroll to top when new entries arrive
  useEffect(() => {
    if (autoScroll && activity.length > prevCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    prevCountRef.current = activity.length;
  }, [activity.length, autoScroll]);

  // Refresh relative times every 30s
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 pb-3 border-b border-border/40">
        <div className="flex items-center gap-2">
          <ActivityIcon className="size-3.5 text-primary" />
          <h3 className="text-xs font-bold uppercase tracking-wide text-foreground">Activity</h3>
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] tabular-nums">
            {activity.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={cn(
            "size-2 rounded-full transition-colors",
            loading ? "bg-amber-500 animate-pulse" : "bg-emerald-500",
          )} />
          <span className="text-[10px] text-muted-foreground">
            {loading ? "Connecting…" : "Live"}
          </span>
          <Button
            variant={autoScroll ? "default" : "ghost"}
            size="icon"
            className="size-6 ml-1"
            onClick={() => setAutoScroll((v) => !v)}
            title={autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
          >
            <ArrowDownIcon className="size-3" />
          </Button>
        </div>
      </div>

      {/* Feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto pt-2 -mx-1 px-1">
        {loading && activity.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="size-8 rounded-full bg-muted flex items-center justify-center mb-3 animate-pulse">
              <ActivityIcon className="size-4 text-muted-foreground" />
            </div>
            <p className="text-xs text-muted-foreground">Waiting for activity…</p>
          </div>
        ) : activity.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="size-8 rounded-full bg-muted flex items-center justify-center mb-3">
              <ActivityIcon className="size-4 text-muted-foreground/40" />
            </div>
            <p className="text-xs text-muted-foreground">No activity yet</p>
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">Activity will appear here when tickets are executed</p>
          </div>
        ) : (
          <ActivityList
            activity={activity}
            expandedId={expandedId}
            toggleExpand={toggleExpand}
            onTicketClick={onTicketClick}
          />
        )}
      </div>
    </div>
  );
}

function ActivityList({
  activity,
  expandedId,
  toggleExpand,
  onTicketClick,
}: {
  activity: LiveLog[];
  expandedId: string | null;
  toggleExpand: (id: string) => void;
  onTicketClick: (ticketId: string) => void;
}) {
  const now = Date.now();
  const startOfToday = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const fmtMonth = (d: Date) =>
    d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const bucketFor = (iso: string | undefined) => {
    if (!iso) return "Earlier";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "Earlier";
    if (t >= startOfToday) return "Today";
    if (t >= startOfYesterday) return "Yesterday";
    return fmtMonth(new Date(t));
  };
  const rows = activity.slice(0, 30);
  let lastBucket: string | null = null;
  const out: React.ReactNode[] = [];
  rows.forEach((entry, index) => {
    const bucket = bucketFor(entry.occurred_at);
    if (bucket !== lastBucket) {
      out.push(
        <div
          key={`hdr-${bucket}-${index}`}
          className="mt-2 first:mt-0 px-1 pt-1 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/60"
        >
          {bucket}
        </div>,
      );
      lastBucket = bucket;
    }

    const config = LEVEL_CONFIG[entry.level || "info"] || LEVEL_CONFIG.info;
    const LevelIcon = config.icon;
    const isExpanded = expandedId === entry.id;
    const isNew = index === 0 && activity.length > 1;
    const isWorker = entry.source === "Worker";

    out.push(
      <button
        key={entry.id}
        onClick={() => {
          if (entry.ticket_id) onTicketClick(entry.ticket_id);
        }}
        className={cn(
          "w-full text-left rounded-lg border-l-[3px] border border-border/40 px-2.5 py-1.5 transition-all duration-200 cursor-pointer",
          "hover:bg-muted/40 hover:border-border/60",
          config.border,
          isNew && "animate-in fade-in slide-in-from-top-2 duration-300",
        )}
      >
        <div className="flex items-center gap-2">
          <LevelIcon className={cn("size-3 shrink-0", config.text)} />
          <span className={cn("text-[11px] font-semibold flex-1 truncate", config.text)}>
            {entry.event}
          </span>
          {entry.occurred_at && (
            <span className="text-[9px] text-muted-foreground/60 shrink-0 tabular-nums">
              {relativeTime(entry.occurred_at)}
            </span>
          )}
        </div>
        {entry.ticket_title && (
          <p className="text-[11px] font-medium text-foreground/80 truncate mt-0.5 pl-5">
            {entry.ticket_title}
          </p>
        )}
        {(entry.actor_name || (entry.source && !isWorker)) && (
          <div className="flex items-center gap-1.5 mt-0.5 pl-5 text-[9px] text-muted-foreground/70">
            {entry.actor_name ? (
              <span
                className="inline-flex items-center gap-1"
                title={entry.actor_email || undefined}
              >
                <UserIcon className="size-2.5 text-muted-foreground/60" />
                <span className="font-medium text-muted-foreground">{entry.actor_name}</span>
              </span>
            ) : null}
            {entry.source && !isWorker && (
              <span className="inline-flex items-center gap-1">
                {entry.actor_name ? <span className="text-muted-foreground/30">·</span> : null}
                <BotIcon className="size-2.5 text-muted-foreground/50" />
                <span className="text-muted-foreground/60">{entry.source}</span>
              </span>
            )}
          </div>
        )}
        {entry.details && (
          <div className="mt-0.5 pl-5">
            <p
              onClick={(e) => { e.stopPropagation(); toggleExpand(entry.id); }}
              className={cn(
                "text-[10px] text-muted-foreground/70 leading-relaxed cursor-pointer hover:text-muted-foreground transition-colors",
                !isExpanded && "line-clamp-1",
              )}
            >
              {entry.details}
            </p>
          </div>
        )}
      </button>,
    );
  });

  return <div className="flex flex-col gap-1">{out}</div>;
}
