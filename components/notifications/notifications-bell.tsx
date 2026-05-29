"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BellIcon, CheckCheckIcon, InfoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type NotificationRow = {
  id: string;
  kind: string;
  actor_name: string | null;
  actor_email: string | null;
  board_id: string | null;
  ticket_id: string | null;
  comment_id: string | null;
  preview: string;
  read_at: string | null;
  created_at: string;
  ticket_title?: string | null;
  board_name?: string | null;
};

type AssignedTicket = {
  id: string;
  title: string;
  priority: string;
  due_date: string | null;
  board_id: string;
  board_name: string;
  column_title: string;
  updated_at: string;
};

type Diagnostics = {
  sessionEmail: string;
  hasMatchingAssignee: boolean;
  assigneeCountTotal: number;
};

type AuthState = "loading" | "unauthenticated" | "ready";

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return "";
  const diff = Math.max(0, now - then);
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function priorityDotClass(p: string): string {
  switch (p) {
    case "urgent": return "bg-rose-600";
    case "high": return "bg-orange-500";
    case "medium": return "bg-amber-500";
    default: return "bg-emerald-500";
  }
}

export function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"mentions" | "assigned">("mentions");
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [assigned, setAssigned] = useState<AssignedTicket[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [unread, setUnread] = useState(0);
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [loading, setLoading] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications/inbox", { cache: "reload" });
      if (res.status === 401) {
        setAuthState("unauthenticated");
        return;
      }
      if (!res.ok) return;
      const json = await res.json();
      if (json.ok) {
        setAuthState("ready");
        setItems(json.notifications || []);
        setAssigned(json.assignedTickets || []);
        setDiagnostics(json.diagnostics || null);
        setUnread(Number(json.unread || 0));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload when the popover opens, so assigned tickets stay fresh.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Live updates for mentions via the shared SSE channel.
  useEffect(() => {
    const es = new EventSource("/api/events");
    eventSourceRef.current = es;
    const handler = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const row = data.row as NotificationRow | undefined;
        if (!row) return;
        setItems((prev) => [row, ...prev.filter((x) => x.id !== row.id)].slice(0, 30));
        if (!row.read_at) setUnread((u) => u + 1);
      } catch {
        // ignore
      }
    };
    es.addEventListener("notification", handler as EventListener);
    return () => {
      es.removeEventListener("notification", handler as EventListener);
      es.close();
    };
  }, []);

  const markRead = useCallback(async (notificationId: string) => {
    await fetch("/api/notifications/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "markRead", notificationId }),
    });
    setItems((prev) =>
      prev.map((n) => (n.id === notificationId ? { ...n, read_at: new Date().toISOString() } : n)),
    );
    setUnread((u) => Math.max(0, u - 1));
  }, []);

  const markAllRead = useCallback(async () => {
    await fetch("/api/notifications/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "markAllRead" }),
    });
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
    setUnread(0);
  }, []);

  const openTicket = useCallback(
    async (boardId: string | null, ticketId: string | null, notificationId?: string) => {
      if (notificationId) {
        const n = items.find((x) => x.id === notificationId);
        if (n && !n.read_at) await markRead(notificationId);
      }
      setOpen(false);
      if (!boardId) return;
      router.push(`/boards?board=${boardId}`);
      if (ticketId) {
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("mc:open-ticket", { detail: { ticketId, boardId } }),
          );
        }, 300);
      }
    },
    [items, markRead, router],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-8"
          aria-label={unread > 0 ? `${unread} unread notifications` : "Notifications"}
        >
          <BellIcon className="size-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-semibold leading-none text-destructive-foreground tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        {authState === "unauthenticated" ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            Sign in to see your inbox.
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wide">Inbox</span>
              {tab === "mentions" && unread > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => void markAllRead()}
                >
                  <CheckCheckIcon className="size-3" /> Mark all read
                </Button>
              )}
            </div>

            {/* Segmented tabs */}
            <div className="flex border-b text-xs">
              <button
                onClick={() => setTab("mentions")}
                className={cn(
                  "flex-1 px-3 py-2 transition-colors",
                  tab === "mentions" ? "border-b-2 border-foreground font-semibold" : "text-muted-foreground hover:text-foreground",
                )}
              >
                Mentions {unread > 0 && <span className="ml-1 rounded-full bg-destructive/15 px-1.5 text-[10px] font-medium text-destructive tabular-nums">{unread}</span>}
              </button>
              <button
                onClick={() => setTab("assigned")}
                className={cn(
                  "flex-1 px-3 py-2 transition-colors",
                  tab === "assigned" ? "border-b-2 border-foreground font-semibold" : "text-muted-foreground hover:text-foreground",
                )}
              >
                My tickets <span className="ml-1 rounded-full bg-foreground/10 px-1.5 text-[10px] font-medium tabular-nums">{assigned.length}</span>
              </button>
            </div>

            <ScrollArea className="max-h-[420px]">
              {tab === "mentions" ? (
                <MentionsTab
                  items={items}
                  loading={loading}
                  diagnostics={diagnostics}
                  onOpen={openTicket}
                />
              ) : (
                <AssignedTab
                  items={assigned}
                  loading={loading}
                  diagnostics={diagnostics}
                  onOpen={openTicket}
                />
              )}
            </ScrollArea>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MentionsTab({
  items,
  loading,
  diagnostics,
  onOpen,
}: {
  items: NotificationRow[];
  loading: boolean;
  diagnostics: Diagnostics | null;
  onOpen: (boardId: string | null, ticketId: string | null, notificationId?: string) => void;
}) {
  if (loading && items.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</p>;
  }
  if (items.length === 0) {
    return <EmptyMentions diagnostics={diagnostics} />;
  }
  return (
    <ul className="divide-y">
      {items.map((n) => {
        const unreadRow = !n.read_at;
        return (
          <li key={n.id}>
            <button
              onClick={() => onOpen(n.board_id, n.ticket_id, n.id)}
              className={cn(
                "block w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/40",
                unreadRow && "bg-blue-500/[0.04]",
              )}
            >
              <div className="flex items-start gap-2">
                {unreadRow && (
                  <span className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full bg-blue-500" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs">
                    <span className="font-semibold text-foreground">{n.actor_name || "Someone"}</span>{" "}
                    <span className="text-muted-foreground">mentioned you</span>
                    {n.ticket_title && (
                      <>
                        {" "}
                        <span className="text-muted-foreground">in</span>{" "}
                        <span className="font-medium text-foreground">{n.ticket_title}</span>
                      </>
                    )}
                  </p>
                  {n.preview && (
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{n.preview}</p>
                  )}
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                    {n.board_name && <span className="truncate">{n.board_name}</span>}
                    {n.board_name && <span>·</span>}
                    <span className="tabular-nums">{relativeTime(n.created_at)}</span>
                  </div>
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AssignedTab({
  items,
  loading,
  diagnostics,
  onOpen,
}: {
  items: AssignedTicket[];
  loading: boolean;
  diagnostics: Diagnostics | null;
  onOpen: (boardId: string | null, ticketId: string | null) => void;
}) {
  if (loading && items.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</p>;
  }
  if (items.length === 0) {
    return <EmptyAssigned diagnostics={diagnostics} />;
  }
  return (
    <ul className="divide-y">
      {items.map((t) => (
        <li key={t.id}>
          <button
            onClick={() => onOpen(t.board_id, t.id)}
            className="block w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
          >
            <div className="flex items-start gap-2">
              <span className={cn("mt-1.5 inline-block size-1.5 shrink-0 rounded-full", priorityDotClass(t.priority))} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{t.title}</p>
                <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <span className="truncate">{t.board_name}</span>
                  <span>·</span>
                  <span className="truncate">{t.column_title}</span>
                  {t.due_date && (
                    <>
                      <span>·</span>
                      <span className="tabular-nums">due {t.due_date}</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EmptyMentions({ diagnostics }: { diagnostics: Diagnostics | null }) {
  if (!diagnostics) {
    return <p className="px-3 py-8 text-center text-xs text-muted-foreground">You're all caught up.</p>;
  }
  if (!diagnostics.hasMatchingAssignee) {
    return (
      <div className="px-3 py-6">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <div className="min-w-0">
            <p className="font-medium text-foreground">Mentions won't reach you yet</p>
            <p className="mt-1 text-muted-foreground">
              No board assignee has an email matching{" "}
              <span className="rounded bg-muted px-1 font-mono text-[10px]">{diagnostics.sessionEmail}</span>.
              Open the boards toolbar → <span className="font-medium">Assignees</span> and add yourself
              with your email so others can <span className="font-mono">@you</span>.
            </p>
          </div>
        </div>
      </div>
    );
  }
  return <p className="px-3 py-8 text-center text-xs text-muted-foreground">You're all caught up.</p>;
}

function EmptyAssigned({ diagnostics }: { diagnostics: Diagnostics | null }) {
  if (diagnostics && !diagnostics.hasMatchingAssignee) {
    return (
      <div className="px-3 py-6">
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          <div className="min-w-0">
            <p className="font-medium text-foreground">Nothing assigned to you yet</p>
            <p className="mt-1 text-muted-foreground">
              No board assignee has the email{" "}
              <span className="rounded bg-muted px-1 font-mono text-[10px]">{diagnostics.sessionEmail}</span>.
              Add yourself as an assignee on a board first.
            </p>
          </div>
        </div>
      </div>
    );
  }
  return <p className="px-3 py-8 text-center text-xs text-muted-foreground">Nothing assigned to you.</p>;
}
