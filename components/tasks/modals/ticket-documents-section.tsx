"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  FileTextIcon,
  FileCodeIcon,
  FileIcon,
  LinkIcon,
  PlusIcon,
  XIcon,
  ExternalLinkIcon,
  GlobeIcon,
  FolderOpenIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LinkDocumentDialog } from "@/components/tasks/modals/link-document-dialog";
import { useModules } from "@/components/modules/modules-provider";

type LinkedDocument = {
  id: string;
  relative_path: string;
  kind: "file" | "folder";
  size_bytes: number;
  extension: string | null;
  last_edited_by_name: string | null;
  last_edited_by_email: string | null;
  updated_at: string;
  linked_by_name: string | null;
  linked_at: string;
};

type TicketLink = {
  id: string;
  kind: "url" | "path";
  url: string;
  label: string | null;
  added_by_name: string | null;
  added_at: string;
};

type Props = {
  ticketId: string | null;
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/**
 * Copies text to the clipboard. Returns synchronously (so the execCommand
 * fallback stays inside the user gesture) and works in non-secure contexts —
 * the dashboard is often served over plain http where navigator.clipboard is
 * unavailable.
 */
function copyText(text: string): boolean {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    void navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function iconFor(ext: string | null): typeof FileTextIcon {
  if (!ext) return FileIcon;
  if ([".md", ".markdown", ".txt", ".rtf"].includes(ext)) return FileTextIcon;
  if ([".html", ".htm", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".sql", ".py", ".sh", ".css", ".scss"].includes(ext)) return FileCodeIcon;
  return FileIcon;
}
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function TicketDocumentsSection({ ticketId }: Props) {
  const { isEnabled } = useModules();
  const moduleEnabled = isEnabled("documents");
  const [docs, setDocs] = useState<LinkedDocument[]>([]);
  const [links, setLinks] = useState<TicketLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    if (!ticketId || !moduleEnabled) return;
    setLoading(true);
    try {
      const [docsRes, linksRes] = await Promise.all([
        fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "listTicketDocuments", ticketId }),
        }).then((r) => r.json()),
        fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "listTicketLinks", ticketId }),
        }).then((r) => r.json()),
      ]);
      if (docsRes.ok) setDocs(docsRes.documents || []);
      if (linksRes.ok) setLinks(linksRes.links || []);
    } finally {
      setLoading(false);
    }
  }, [ticketId, moduleEnabled]);

  useEffect(() => { void load(); }, [load]);

  const unlink = useCallback(async (documentId: string) => {
    if (!ticketId) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "unlinkTicketDocument", ticketId, documentId }),
    });
    await load();
  }, [ticketId, load]);

  const removeLink = useCallback(async (linkId: string) => {
    if (!ticketId) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "removeTicketLink", ticketId, linkId }),
    });
    await load();
  }, [ticketId, load]);

  const alreadyLinkedIds = useMemo(() => new Set(docs.map((d) => d.id)), [docs]);

  if (!ticketId) return null;
  // Module disabled — render nothing at all (silent integration).
  if (!moduleEnabled) return null;

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
        <LinkIcon className="size-3" /> Documents &amp; links ({docs.length + links.length})
      </Label>

      {docs.length === 0 && links.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No documents or links yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {docs.map((d) => {
            const Icon = iconFor(d.extension);
            return (
              <li
                key={d.id}
                className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/10 px-2.5 py-1.5 text-xs"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{d.relative_path}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {bytes(d.size_bytes)}
                    {d.last_edited_by_name && ` · edited ${relTime(d.updated_at)} by ${d.last_edited_by_name}`}
                  </p>
                </div>
                <a
                  href={`/documents?path=${encodeURIComponent(d.relative_path)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                  title="Open in Documents"
                >
                  <ExternalLinkIcon className="size-3.5" />
                </a>
                <button
                  onClick={() => void unlink(d.id)}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                  title="Unlink"
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            );
          })}
          {links.map((l) => {
            const isPath = l.kind === "path";
            const display = l.label?.trim() || (isPath ? basenameOf(l.url) : hostnameOf(l.url));
            const Icon = isPath ? FolderOpenIcon : GlobeIcon;
            return (
              <li
                key={l.id}
                className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/10 px-2.5 py-1.5 text-xs"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{display}</p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">{l.url}</p>
                </div>
                {isPath ? (
                  <a
                    href={`mc-explorer:${encodeURIComponent(l.url)}`}
                    onClick={() => {
                      // The href still fires the mc-explorer: handler for anyone
                      // who installed it. Regardless, copy the path so it always
                      // does something useful even without the handler.
                      const ok = copyText(l.url);
                      if (ok) {
                        toast.success("Path copied to clipboard", {
                          description: "If Explorer didn't open, paste it into Explorer's address bar (Win+E, then Ctrl+L).",
                        });
                      } else {
                        toast.error("Couldn't copy automatically — here's the path", { description: l.url });
                      }
                    }}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    title="Copy path (and open in Explorer if the one-time setup is installed)"
                  >
                    <ExternalLinkIcon className="size-3.5" />
                  </a>
                ) : (
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    title="Open link"
                  >
                    <ExternalLinkIcon className="size-3.5" />
                  </a>
                )}
                <button
                  onClick={() => void removeLink(l.id)}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                  title="Remove link"
                >
                  <XIcon className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        size="sm"
        variant="outline"
        className="self-start gap-1.5 text-xs"
        onClick={() => setPickerOpen(true)}
        disabled={loading}
      >
        <PlusIcon className="size-3.5" />
        Link document, URL, or path
      </Button>

      <LinkDocumentDialog
        open={pickerOpen}
        ticketId={ticketId}
        alreadyLinkedIds={alreadyLinkedIds}
        onClose={() => setPickerOpen(false)}
        onLinked={() => void load()}
      />
    </div>
  );
}
