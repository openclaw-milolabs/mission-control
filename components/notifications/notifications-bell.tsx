"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BellIcon, CheckCheckIcon } from "lucide-react";
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

export function NotificationsBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications/inbox", { cache: "reload" });
      if (!res.ok) return;
      const json = await res.json();
      if (json.ok) {
        setItems(json.notifications || []);
        setUnread(Number(json.unread || 0));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live updates via the shared SSE channel.
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
    async (n: NotificationRow) => {
      if (!n.read_at) await markRead(n.id);
      setOpen(false);
      if (n.board_id) {
        router.push(`/boards?board=${n.board_id}`);
        if (n.ticket_id) {
          // Wait a tick for the boards page to mount, then dispatch the existing
          // mc:open-ticket event the page already listens for.
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("mc:open-ticket", {
                detail: { ticketId: n.ticket_id, boardId: n.board_id },
              }),
            );
          }, 300);
        }
      }
    },
    [markRead, router],
  );

  const sorted = useMemo(() => items, [items]);

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
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide">Inbox</span>
            {unread > 0 && (
              <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
                {unread} new
              </span>
            )}
          </div>
          {unread > 0 && (
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
        <ScrollArea className="max-h-[400px]">
          {loading && items.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</p>
          ) : sorted.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              You're all caught up.
            </p>
          ) : (
            <ul className="divide-y">
              {sorted.map((n) => {
                const unreadRow = !n.read_at;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => void openTicket(n)}
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
                            <span className="font-semibold text-foreground">
                              {n.actor_name || "Someone"}
                            </span>{" "}
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
                            <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                              {n.preview}
                            </p>
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
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
