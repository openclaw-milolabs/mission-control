"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FileTextIcon,
  FileCodeIcon,
  FileIcon,
  LinkIcon,
  PlusIcon,
  XIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LinkDocumentDialog } from "@/components/tasks/modals/link-document-dialog";

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

type Props = {
  ticketId: string | null;
};

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
  const [docs, setDocs] = useState<LinkedDocument[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    if (!ticketId) return;
    setLoading(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "listTicketDocuments", ticketId }),
      });
      const j = await res.json();
      if (j.ok) setDocs(j.documents || []);
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

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

  const alreadyLinkedIds = useMemo(() => new Set(docs.map((d) => d.id)), [docs]);

  if (!ticketId) return null;

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
        <LinkIcon className="size-3" /> Documents ({docs.length})
      </Label>

      {docs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No documents linked yet.</p>
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
        Link document
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
