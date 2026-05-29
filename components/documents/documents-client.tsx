"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  ChevronRightIcon,
  FilePlusIcon,
  FolderPlusIcon,
  HomeIcon,
  HistoryIcon,
  LinkIcon,
  Loader2Icon,
  PencilIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
  FileTextIcon,
  FileCodeIcon,
  FileIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FolderIcon,
  PlusIcon,
  EyeIcon,
  EditIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const TiptapEditor = dynamic(() => import("./tiptap-editor").then((m) => m.TiptapEditor), {
  ssr: false,
  loading: () => <EditorSkeleton label="Loading rich-text editor…" />,
});
const MonacoCodeEditor = dynamic(() => import("./monaco-code-editor").then((m) => m.MonacoCodeEditor), {
  ssr: false,
  loading: () => <EditorSkeleton label="Loading code editor…" />,
});

type DirEntry = {
  name: string;
  relativePath: string;
  kind: "file" | "folder";
  sizeBytes: number;
  extension: string | null;
  modifiedAt: string;
};

type RecentDoc = {
  id: string;
  relative_path: string;
  kind: "file" | "folder";
  size_bytes: number;
  extension: string | null;
  updated_at: string;
  last_edited_by_name: string | null;
  created_by_name: string | null;
};

type AuditRow = {
  id: string;
  document_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  event: string;
  details: Record<string, unknown>;
  occurred_at: string;
};

type LinkedTicket = {
  id: string;
  title: string;
  board_id: string;
  board_name: string;
  linked_at: string;
  linked_by_name: string | null;
};

type Tab = "edit" | "preview" | "history";

const RICH_TEXT_EXTS = new Set([".md", ".markdown", ".html", ".htm", ".txt", ".rtf"]);

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}
function dirname(p: string): string {
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
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
function iconForFile(ext: string | null): typeof FileTextIcon {
  if (!ext) return FileIcon;
  if ([".md", ".markdown", ".txt", ".rtf"].includes(ext)) return FileTextIcon;
  if ([".html", ".htm", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".sql", ".py", ".sh", ".css", ".scss"].includes(ext)) return FileCodeIcon;
  return FileIcon;
}

export function DocumentsClient() {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [recent, setRecent] = useState<RecentDoc[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<Tab>("edit");
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [linkedTickets, setLinkedTickets] = useState<LinkedTicket[]>([]);
  const [docMeta, setDocMeta] = useState<RecentDoc | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set([""]));
  const [newOpen, setNewOpen] = useState<null | { kind: "file" | "folder"; parent: string }>(null);
  const [renameOpen, setRenameOpen] = useState<null | { path: string }>(null);
  const [deleteOpen, setDeleteOpen] = useState<null | { path: string; kind: "file" | "folder" }>(null);
  const [authError, setAuthError] = useState(false);
  const isDirty = content !== savedContent;

  const reloadTree = useCallback(async () => {
    try {
      const res = await fetch("/api/documents", { cache: "reload" });
      if (res.status === 401) { setAuthError(true); return; }
      if (!res.ok) return;
      const json = await res.json();
      if (json.ok) setEntries(json.entries || []);
    } catch { /* ignore */ }
  }, []);

  const reloadRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/documents?recent=1&limit=12", { cache: "reload" });
      if (!res.ok) return;
      const json = await res.json();
      if (json.ok) setRecent(json.recent || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void reloadTree();
    void reloadRecent();
  }, [reloadTree, reloadRecent]);

  // Load doc content + metadata + linked tickets when selection changes.
  useEffect(() => {
    if (!selectedPath) {
      setContent(""); setSavedContent(""); setAudit([]); setLinkedTickets([]); setDocMeta(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoadingDoc(true);
      try {
        const cRes = await fetch(`/api/documents/content?path=${encodeURIComponent(selectedPath)}`);
        if (cancelled) return;
        if (cRes.ok) {
          const cJson = await cRes.json();
          if (cJson.ok) {
            setContent(cJson.content || "");
            setSavedContent(cJson.content || "");
          }
        }
        // Get the doc row to fetch id + audit + linked tickets.
        const meta = recent.find((r) => r.relative_path === selectedPath);
        let docId = meta?.id;
        if (!docId) {
          // Fall back: list all to find id.
          const allRes = await fetch("/api/documents?recent=1&limit=200");
          if (allRes.ok) {
            const j = await allRes.json();
            docId = (j.recent || []).find((r: RecentDoc) => r.relative_path === selectedPath)?.id;
          }
        }
        if (docId) {
          setDocMeta(meta || null);
          const [auditRes, ticketsRes] = await Promise.all([
            fetch("/api/documents", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "listAudit", documentId: docId, limit: 50 }),
            }),
            fetch("/api/documents", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "listDocumentTickets", documentId: docId }),
            }),
          ]);
          if (!cancelled) {
            if (auditRes.ok) {
              const j = await auditRes.json();
              setAudit(j.audit || []);
            }
            if (ticketsRes.ok) {
              const j = await ticketsRes.json();
              setLinkedTickets(j.tickets || []);
            }
          }
        }
      } finally {
        if (!cancelled) setLoadingDoc(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [selectedPath, recent]);

  const handleSave = useCallback(async () => {
    if (!selectedPath || saving || !isDirty) return;
    setSaving(true);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "updateContent", path: selectedPath, content }),
      });
      const j = await res.json();
      if (j.ok) {
        setSavedContent(content);
        toast.success("Saved", { description: selectedPath });
        void reloadRecent();
      } else {
        toast.error(j.error || "Failed to save");
      }
    } finally {
      setSaving(false);
    }
  }, [selectedPath, saving, isDirty, content, reloadRecent]);

  // Ctrl/Cmd+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave]);

  const handleCreate = useCallback(async (kind: "file" | "folder", parent: string, name: string) => {
    const cleanName = name.trim();
    if (!cleanName) return { ok: false, error: "Name is required." };
    const path = parent ? `${parent}/${cleanName}` : cleanName;
    const action = kind === "folder" ? "createFolder" : "createFile";
    const res = await fetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, path, content: "" }),
    });
    const j = await res.json();
    if (j.ok) {
      await reloadTree();
      await reloadRecent();
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.add(parent);
        return next;
      });
      if (kind === "file") setSelectedPath(path);
      return { ok: true };
    }
    return { ok: false, error: j.error };
  }, [reloadTree, reloadRecent]);

  const handleRename = useCallback(async (fromPath: string, newName: string) => {
    const parent = dirname(fromPath);
    const toPath = parent ? `${parent}/${newName.trim()}` : newName.trim();
    if (!toPath || toPath === fromPath) return { ok: false, error: "New name is required." };
    const res = await fetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rename", fromPath, toPath }),
    });
    const j = await res.json();
    if (j.ok) {
      await reloadTree();
      await reloadRecent();
      if (selectedPath === fromPath) setSelectedPath(toPath);
      return { ok: true };
    }
    return { ok: false, error: j.error };
  }, [reloadTree, reloadRecent, selectedPath]);

  const handleDelete = useCallback(async (path: string) => {
    const res = await fetch("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "deleteDoc", path }),
    });
    const j = await res.json();
    if (j.ok) {
      await reloadTree();
      await reloadRecent();
      if (selectedPath === path || selectedPath?.startsWith(`${path}/`)) setSelectedPath(null);
      toast.success("Deleted", { description: path });
      return { ok: true };
    }
    toast.error(j.error || "Failed to delete");
    return { ok: false, error: j.error };
  }, [reloadTree, reloadRecent, selectedPath]);

  // Group entries into a tree structure by directory.
  const childrenByParent = useMemo(() => {
    const out: Record<string, DirEntry[]> = { "": [] };
    for (const e of entries) {
      const parent = dirname(e.relativePath);
      if (!out[parent]) out[parent] = [];
      out[parent].push(e);
    }
    return out;
  }, [entries]);

  const breadcrumbs = useMemo(() => {
    if (!selectedPath) return [];
    const parts = selectedPath.split("/").filter(Boolean);
    return parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join("/") }));
  }, [selectedPath]);

  const ext = useMemo(() => {
    if (!selectedPath) return null;
    const i = selectedPath.lastIndexOf(".");
    return i >= 0 ? selectedPath.slice(i).toLowerCase() : null;
  }, [selectedPath]);
  const isRichText = ext ? RICH_TEXT_EXTS.has(ext) : true;

  if (authError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        Sign in to access documents.
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Sidebar tree */}
      <aside className="hidden w-72 shrink-0 border-r bg-muted/10 md:flex md:flex-col">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            Files
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="New">
                <PlusIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setNewOpen({ kind: "file", parent: "" })}>
                <FilePlusIcon className="h-4 w-4" /> New file
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setNewOpen({ kind: "folder", parent: "" })}>
                <FolderPlusIcon className="h-4 w-4" /> New folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <ScrollArea className="flex-1">
          <DocTree
            parent=""
            childrenByParent={childrenByParent}
            expanded={expandedFolders}
            onToggle={(path) => {
              setExpandedFolders((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              });
            }}
            onSelect={(path) => setSelectedPath(path)}
            selectedPath={selectedPath}
            onNewIn={(parent, kind) => setNewOpen({ kind, parent })}
            onRename={(path) => setRenameOpen({ path })}
            onDelete={(path, kind) => setDeleteOpen({ path, kind })}
          />
          {entries.length === 0 && (
            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
              No documents yet. <br />
              Use <span className="font-medium text-foreground">+ New</span> above.
            </div>
          )}
        </ScrollArea>
      </aside>

      {/* Main area */}
      <main className="flex flex-1 min-w-0 flex-col">
        {/* Breadcrumbs + actions */}
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <button
            onClick={() => setSelectedPath(null)}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Home"
          >
            <HomeIcon className="h-3.5 w-3.5" />
          </button>
          {breadcrumbs.length === 0 ? (
            <span className="text-xs text-muted-foreground">Recent documents</span>
          ) : (
            breadcrumbs.map((b, i) => (
              <span key={b.path} className="flex items-center gap-2 text-xs">
                <ChevronRightIcon className="h-3 w-3 text-muted-foreground/40" />
                <button
                  onClick={() => {
                    // Clicking an intermediate folder doesn't have an open-folder view here yet;
                    // we just expand it in the tree.
                    if (i < breadcrumbs.length - 1) {
                      setExpandedFolders((prev) => new Set([...prev, b.path]));
                    }
                  }}
                  className={cn(
                    "truncate transition-colors",
                    i === breadcrumbs.length - 1
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {b.name}
                </button>
              </span>
            ))
          )}
          <div className="ml-auto flex items-center gap-2">
            {selectedPath && (
              <>
                {isDirty && (
                  <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    Unsaved
                  </span>
                )}
                <Button
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={!isDirty || saving}
                  className="gap-1.5"
                >
                  {saving ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : <SaveIcon className="h-3.5 w-3.5" />}
                  Save
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Tabs */}
        {selectedPath && (
          <div className="flex border-b text-xs">
            <TabButton active={tab === "edit"} onClick={() => setTab("edit")} icon={EditIcon} label="Edit" />
            {isRichText && (
              <TabButton active={tab === "preview"} onClick={() => setTab("preview")} icon={EyeIcon} label="Preview" />
            )}
            <TabButton active={tab === "history"} onClick={() => setTab("history")} icon={HistoryIcon} label={`History (${audit.length})`} />
          </div>
        )}

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 min-w-0 min-h-0">
            {!selectedPath ? (
              <RecentGrid recent={recent} onOpen={(p) => setSelectedPath(p)} />
            ) : loadingDoc ? (
              <EditorSkeleton label="Loading…" />
            ) : tab === "history" ? (
              <HistoryView audit={audit} />
            ) : tab === "preview" && isRichText ? (
              <PreviewView content={content} ext={ext} />
            ) : isRichText ? (
              <TiptapEditor content={content} onChange={setContent} ext={ext} />
            ) : (
              <MonacoCodeEditor content={content} onChange={setContent} ext={ext} />
            )}
          </div>

          {/* Right info panel */}
          {selectedPath && (
            <aside className="hidden w-72 shrink-0 border-l bg-muted/10 lg:flex lg:flex-col">
              <div className="border-b px-3 py-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Details
                </span>
              </div>
              <ScrollArea className="flex-1 px-3 py-3">
                <DetailRow label="Path" value={selectedPath} mono />
                <DetailRow label="Size" value={bytes(savedContent.length)} />
                {ext && <DetailRow label="Type" value={ext} mono />}
                {docMeta?.created_by_name && (
                  <DetailRow label="Created by" value={docMeta.created_by_name} />
                )}
                {docMeta?.last_edited_by_name && (
                  <DetailRow label="Last edited" value={`${docMeta.last_edited_by_name} · ${relTime(docMeta.updated_at)}`} />
                )}

                <div className="mt-4 mb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Linked tickets ({linkedTickets.length})
                </div>
                {linkedTickets.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground/60">Not linked from any ticket yet.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {linkedTickets.map((t) => (
                      <a
                        key={t.id}
                        href={`/boards?board=${t.board_id}&ticket=${t.id}`}
                        className="flex items-start gap-2 rounded-md border border-border/60 bg-background px-2 py-1.5 text-[11px] transition-colors hover:bg-accent"
                      >
                        <LinkIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{t.title}</p>
                          <p className="truncate text-[10px] text-muted-foreground">{t.board_name}</p>
                        </div>
                      </a>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </aside>
          )}
        </div>
      </main>

      {/* Dialogs */}
      {newOpen && (
        <NewDocumentDialog
          kind={newOpen.kind}
          parent={newOpen.parent}
          onClose={() => setNewOpen(null)}
          onCreate={async (kind, parent, name) => {
            const r = await handleCreate(kind, parent, name);
            if (r.ok) setNewOpen(null);
            return r;
          }}
        />
      )}

      {renameOpen && (
        <RenameDialog
          path={renameOpen.path}
          onClose={() => setRenameOpen(null)}
          onRename={async (path, newName) => {
            const r = await handleRename(path, newName);
            if (r.ok) setRenameOpen(null);
            return r;
          }}
        />
      )}

      <AlertDialog open={!!deleteOpen} onOpenChange={(o) => { if (!o) setDeleteOpen(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2Icon className="size-5 text-destructive" />
              Delete {deleteOpen?.kind}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteOpen?.kind === "folder"
                ? `Delete "${deleteOpen.path}" and everything inside it? This cannot be undone.`
                : `Delete "${deleteOpen?.path}"? This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={async () => {
                if (deleteOpen) {
                  await handleDelete(deleteOpen.path);
                  setDeleteOpen(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function TabButton({
  active, onClick, icon: Icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof EditIcon;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-4 py-2 transition-colors",
        active ? "border-b-2 border-foreground font-semibold" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="mb-2">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className={cn("text-xs text-foreground/90 break-all", mono && "font-mono")}>{value}</div>
    </div>
  );
}

function DocTree({
  parent,
  childrenByParent,
  expanded,
  onToggle,
  onSelect,
  selectedPath,
  onNewIn,
  onRename,
  onDelete,
}: {
  parent: string;
  childrenByParent: Record<string, DirEntry[]>;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  onNewIn: (parent: string, kind: "file" | "folder") => void;
  onRename: (path: string) => void;
  onDelete: (path: string, kind: "file" | "folder") => void;
}) {
  const list = childrenByParent[parent] || [];
  return (
    <ul className="text-xs">
      {list.map((entry) => {
        if (entry.kind === "folder") {
          const isOpen = expanded.has(entry.relativePath);
          return (
            <li key={entry.relativePath}>
              <div className="group flex items-center gap-1 px-2 py-1 hover:bg-accent/50">
                <button
                  onClick={() => onToggle(entry.relativePath)}
                  className="flex flex-1 items-center gap-1 truncate text-left"
                >
                  {isOpen ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" />}
                  <FolderIcon className={cn("size-3.5 shrink-0", isOpen ? "text-amber-500" : "text-muted-foreground")} />
                  <span className="truncate">{entry.name}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" className="size-5 opacity-0 transition-opacity group-hover:opacity-100">
                      <PlusIcon className="size-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onNewIn(entry.relativePath, "file")}>
                      <FilePlusIcon className="size-3.5" /> New file in here
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onNewIn(entry.relativePath, "folder")}>
                      <FolderPlusIcon className="size-3.5" /> New folder in here
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onRename(entry.relativePath)}>
                      <PencilIcon className="size-3.5" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete(entry.relativePath, "folder")}>
                      <Trash2Icon className="size-3.5" /> Delete folder
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {isOpen && (
                <div className="pl-3">
                  <DocTree
                    parent={entry.relativePath}
                    childrenByParent={childrenByParent}
                    expanded={expanded}
                    onToggle={onToggle}
                    onSelect={onSelect}
                    selectedPath={selectedPath}
                    onNewIn={onNewIn}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                </div>
              )}
            </li>
          );
        }
        const Icon = iconForFile(entry.extension);
        const isSelected = selectedPath === entry.relativePath;
        return (
          <li key={entry.relativePath}>
            <div className={cn(
              "group flex items-center gap-1 px-2 py-1 hover:bg-accent/50",
              isSelected && "bg-accent",
            )}>
              <button
                onClick={() => onSelect(entry.relativePath)}
                className="flex flex-1 items-center gap-1.5 truncate pl-4 text-left"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" className="size-5 opacity-0 transition-opacity group-hover:opacity-100">
                    <PencilIcon className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onRename(entry.relativePath)}>
                    <PencilIcon className="size-3.5" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => onDelete(entry.relativePath, "file")}>
                    <Trash2Icon className="size-3.5" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RecentGrid({ recent, onOpen }: { recent: RecentDoc[]; onOpen: (path: string) => void }) {
  if (recent.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
        <FileTextIcon className="size-10 text-muted-foreground/40" />
        <p className="text-sm font-medium">No documents yet</p>
        <p className="text-xs">Use the sidebar to create your first file or folder.</p>
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-6">
        <div className="mb-4 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          Recently edited
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {recent.map((doc) => {
            const Icon = iconForFile(doc.extension);
            return (
              <button
                key={doc.id}
                onClick={() => onOpen(doc.relative_path)}
                className="group flex flex-col gap-2 rounded-lg border border-border/60 bg-background p-4 text-left transition-all hover:-translate-y-0.5 hover:border-border hover:shadow-md"
              >
                <Icon className="size-6 text-muted-foreground transition-colors group-hover:text-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{basename(doc.relative_path)}</p>
                  <p className="truncate text-[10px] text-muted-foreground">{doc.relative_path}</p>
                </div>
                <div className="mt-auto flex items-center justify-between text-[10px] text-muted-foreground/80">
                  <span>{bytes(doc.size_bytes)}</span>
                  <span>{relTime(doc.updated_at)}</span>
                </div>
                {doc.last_edited_by_name && (
                  <div className="text-[10px] text-muted-foreground/60">by {doc.last_edited_by_name}</div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}

function HistoryView({ audit }: { audit: AuditRow[] }) {
  if (audit.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No history yet.
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <ul className="divide-y px-4 py-4">
        {audit.map((row) => (
          <li key={row.id} className="flex items-start gap-3 py-2.5">
            <div className="mt-0.5 size-2 shrink-0 rounded-full bg-blue-500" />
            <div className="min-w-0 flex-1">
              <p className="text-xs">
                <span className="font-medium text-foreground">{row.actor_name || row.actor_email || "Unknown"}</span>{" "}
                <span className="text-muted-foreground">{humaniseEvent(row.event)}</span>
              </p>
              {row.details && (row.details as { from?: string; to?: string }).from && (
                <p className="text-[10px] text-muted-foreground">
                  {String((row.details as { from: string }).from)} → {String((row.details as { to: string }).to)}
                </p>
              )}
              <p className="text-[10px] text-muted-foreground/70">{new Date(row.occurred_at).toLocaleString()}</p>
            </div>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

function humaniseEvent(event: string): string {
  switch (event) {
    case "created": return "created the file";
    case "updated": return "edited the content";
    case "folder_created": return "created the folder";
    case "renamed": return "renamed";
    case "moved": return "moved";
    case "deleted": return "deleted";
    case "linked_to_ticket": return "linked to a ticket";
    case "unlinked_from_ticket": return "unlinked from a ticket";
    default: return event;
  }
}

function PreviewView({ content, ext }: { content: string; ext: string | null }) {
  // Naive markdown preview without a markdown lib (good enough for plain notes).
  // HTML preview renders the raw HTML in a sandboxed iframe.
  if (ext === ".html" || ext === ".htm") {
    return (
      <iframe
        title="HTML preview"
        sandbox=""
        srcDoc={content}
        className="h-full w-full border-0 bg-background"
      />
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="prose prose-sm max-w-none whitespace-pre-wrap p-8 text-foreground/90 dark:prose-invert">
        {content || <span className="text-muted-foreground">Empty document.</span>}
      </div>
    </ScrollArea>
  );
}

function EditorSkeleton({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      {label}
    </div>
  );
}

function NewDocumentDialog({
  kind, parent, onClose, onCreate,
}: {
  kind: "file" | "folder";
  parent: string;
  onClose: () => void;
  onCreate: (kind: "file" | "folder", parent: string, name: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [name, setName] = useState(kind === "file" ? "untitled.md" : "new-folder");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.select(); }, []);

  const submit = async () => {
    setBusy(true);
    setError("");
    const r = await onCreate(kind, parent, name);
    setBusy(false);
    if (!r.ok) setError(r.error || "Failed");
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>New {kind}</DialogTitle>
          <DialogDescription>
            {parent ? <>Inside <span className="font-mono">{parent}/</span></> : "At the documents root."}
            {kind === "file" && (
              <span className="mt-1 block text-[10px] text-muted-foreground/70">
                Tip: include the extension — <span className="font-mono">.md</span>, <span className="font-mono">.html</span>, <span className="font-mono">.js</span>, <span className="font-mono">.json</span>, <span className="font-mono">.sql</span>… whichever you need.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Label htmlFor="nd-name" className="mb-1.5 block text-xs">Name</Label>
          <Input
            id="nd-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            autoFocus
          />
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Creating…" : `Create ${kind}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  path, onClose, onRename,
}: {
  path: string;
  onClose: () => void;
  onRename: (path: string, newName: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [name, setName] = useState(basename(path));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.select(); }, []);

  const submit = async () => {
    setBusy(true);
    setError("");
    const r = await onRename(path, name);
    setBusy(false);
    if (!r.ok) setError(r.error || "Failed");
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>
            Renaming <span className="font-mono">{path}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Label htmlFor="rn-name" className="mb-1.5 block text-xs">New name</Label>
          <Input
            id="rn-name"
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            autoFocus
          />
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
