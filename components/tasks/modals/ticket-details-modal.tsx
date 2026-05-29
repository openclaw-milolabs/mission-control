"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TicketDocumentsSection } from "@/components/tasks/modals/ticket-documents-section";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { TICKET_PRIORITY_OPTIONS } from "@/types/tasks";
import type {
  Assignee,
  Label as BoardLabelType,
  BoardState,
  TicketActivity,
  TicketAttachment,
  TicketComment,
  TicketDetailsForm,
  TicketSubtask,
} from "@/types/tasks";
import {
  BotIcon,
  CheckSquareIcon,
  ClipboardListIcon,
  CopyIcon,
  LinkIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  ListIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  PlusIcon,
  SendHorizonalIcon,
  SquarePenIcon,
  Trash2Icon,
  XIcon,
  ZapIcon,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

type LocalChecklistItem = {
  id: string;
  title: string;
  completed: boolean;
  checklistName: string;
};

type Props = {
  mode?: "create" | "edit";
  open: boolean;
  form: TicketDetailsForm;
  board: BoardState;
  assignees: Assignee[];
  labels: BoardLabelType[];
  boardId: string;
  attachments: TicketAttachment[];
  attachmentsLoading: boolean;
  attachmentsUploading: boolean;
  subtasks: TicketSubtask[];
  subtasksLoading: boolean;
  onAddSubtask: (title: string, checklistName: string) => void;
  onToggleSubtask: (subtaskId: string, completed: boolean) => void;
  onDeleteSubtask: (subtaskId: string) => void;
  onRenameChecklist: (oldName: string, newName: string) => void;
  onDeleteChecklist: (checklistName: string) => void;
  comments: TicketComment[];
  commentsLoading: boolean;
  commentDraft: string;
  onCommentDraftChange: (value: string) => void;
  onAddComment: () => void;
  onDeleteComment: (commentId: string) => void;
  activity: TicketActivity[];
  activityLoading: boolean;
  onChange: (patch: Partial<TicketDetailsForm>) => void;
  onUploadAttachments: (files: FileList | File[] | null) => void;
  onDeleteAttachment: (attachmentId: string) => void;
  onSave: (files?: File[], draftSubtasks?: { checklistName: string; title: string }[]) => void;
  onCopy: () => void;
  onDelete: () => void;
  onClose: () => void;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const formatDate = (v: string) => new Date(v).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const initials = (name: string) => {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return "OC";
  return p.length === 1 ? p[0].slice(0, 2).toUpperCase() : `${p[0][0]}${p[1][0]}`.toUpperCase();
};
const fmtBytes = (s: number) => s < 1024 ? `${s} B` : s < 1048576 ? `${(s / 1024).toFixed(1)} KB` : `${(s / 1048576).toFixed(1)} MB`;

// ── Markdown renderer for agent output ───────────────────────────────────────

function renderActivityInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;
  while (remaining.length > 0) {
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(<code key={key++} className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parts.push(<strong key={key++} className="font-bold">{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }
    const italicMatch = remaining.match(/^\*(.+?)\*/);
    if (italicMatch) {
      parts.push(<em key={key++}>{italicMatch[1]}</em>);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }
    const nextSpecial = remaining.search(/[`*]/);
    if (nextSpecial === -1) { parts.push(remaining); break; }
    if (nextSpecial === 0) { parts.push(remaining[0]); remaining = remaining.slice(1); }
    else { parts.push(remaining.slice(0, nextSpecial)); remaining = remaining.slice(nextSpecial); }
  }
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function ActivityMarkdown({ text }: { text: string }) {
  const cleaned = text.replace(/\n*>\s*`Agent:.*`$/, "").trim();
  const lines = cleaned.split("\n");
  return (
    <div className="flex flex-col gap-0.5 text-[12px] leading-relaxed text-foreground/90">
      {lines.map((line, i) => {
        if (line.startsWith("### ")) return <h4 key={i} className="text-[12px] font-bold mt-2 mb-0.5">{renderActivityInline(line.slice(4))}</h4>;
        if (line.startsWith("## ")) return <h3 key={i} className="text-[13px] font-bold mt-2 mb-0.5">{renderActivityInline(line.slice(3))}</h3>;
        if (line.startsWith("# ")) return <h2 key={i} className="text-sm font-bold mt-2 mb-0.5">{renderActivityInline(line.slice(2))}</h2>;
        if (/^[-*]\s/.test(line)) return (
          <div key={i} className="flex gap-1.5 pl-1">
            <span className="text-muted-foreground shrink-0">•</span>
            <span>{renderActivityInline(line.replace(/^[-*]\s/, ""))}</span>
          </div>
        );
        if (/^\d+\.\s/.test(line)) {
          const num = line.match(/^(\d+)\./)?.[1];
          return (
            <div key={i} className="flex gap-1.5 pl-1">
              <span className="text-muted-foreground shrink-0 tabular-nums">{num}.</span>
              <span>{renderActivityInline(line.replace(/^\d+\.\s/, ""))}</span>
            </div>
          );
        }
        if (line.trim() === "") return <div key={i} className="h-1" />;
        return <p key={i}>{renderActivityInline(line)}</p>;
      })}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

// Small layout primitives that keep the right meta column clean.
// Each group has a single muted SectionHeader at top; each field is just
// label + control, no per-row uppercase shouting.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-foreground/65">{label}</span>
      {children}
    </div>
  );
}

export function TicketDetailsModal({
  mode = "edit", open, form, board, assignees, labels, boardId,
  attachments,
  subtasks,
  onAddSubtask, onToggleSubtask, onDeleteSubtask,
  onRenameChecklist, onDeleteChecklist,
  comments, commentDraft, onCommentDraftChange, onAddComment, onDeleteComment,
  activity, onChange, onUploadAttachments, onDeleteAttachment,
  onSave,
  onCopy, onDelete, onClose,
}: Props) {
  const isEditing = mode === "edit";
  const [createFiles, setCreateFiles] = useState<File[]>([]);
  const [previewAtt, setPreviewAtt] = useState<TicketAttachment | null>(null);
  const hasAgentOutput = activity.some((e) => e.event === "Agent response" || e.event === "Plan generated");
  const [showActivity, setShowActivity] = useState(hasAgentOutput);
  const attachRef = useRef<HTMLInputElement | null>(null);

  // ── Checklist local state ──────────────────────────────────────────────────
  // In create mode: localItems is the source of truth
  // In edit mode: subtasks prop is the source of truth; localItems unused
  const [localItems, setLocalItems] = useState<LocalChecklistItem[]>([]);
  const [draftsByChecklist, setDraftsByChecklist] = useState<Record<string, string>>({});
  const [checklistNamesState, setChecklistNamesState] = useState<string[]>(["Checklist"]);
  const [editingChecklistName, setEditingChecklistName] = useState<string | null>(null);
  const [checklistNameDraft, setChecklistNameDraft] = useState("");
  const [newChecklistInput, setNewChecklistInput] = useState("");
  const [showAddChecklist, setShowAddChecklist] = useState(false);

  // Unified items and names for rendering
  const activeItems: LocalChecklistItem[] = isEditing
    ? subtasks.map((s) => ({ id: s.id, title: s.title, completed: s.completed, checklistName: s.checklistName }))
    : localItems;

  const checklistNames: string[] = isEditing
    ? Array.from(
        new Set([
          ...subtasks.map((s) => s.checklistName),
          ...checklistNamesState.filter((n) => !subtasks.some((s) => s.checklistName === n)),
        ]),
      )
    : checklistNamesState;

  const handleFinishRename = (clName: string) => {
    const newName = checklistNameDraft.trim();
    if (newName && newName !== clName) {
      if (isEditing) {
        onRenameChecklist(clName, newName);
      } else {
        setLocalItems((prev) =>
          prev.map((item) => item.checklistName === clName ? { ...item, checklistName: newName } : item),
        );
        setChecklistNamesState((prev) => prev.map((n) => (n === clName ? newName : n)));
        setDraftsByChecklist((prev) => {
          if (!(clName in prev)) return prev;
          const { [clName]: d, ...rest } = prev;
          return { ...rest, [newName]: d };
        });
      }
    }
    setEditingChecklistName(null);
  };

  const handleAddItem = (clName: string) => {
    const draft = (draftsByChecklist[clName] ?? "").trim();
    if (!draft) return;
    if (isEditing) {
      onAddSubtask(draft, clName);
    } else {
      setLocalItems((prev) => [
        ...prev,
        { id: `local-${Date.now()}-${Math.random()}`, title: draft, completed: false, checklistName: clName },
      ]);
    }
    setDraftsByChecklist((prev) => ({ ...prev, [clName]: "" }));
  };

  const handleDeleteChecklist = (clName: string) => {
    if (isEditing) {
      onDeleteChecklist(clName);
    } else {
      setLocalItems((prev) => prev.filter((i) => i.checklistName !== clName));
      setChecklistNamesState((prev) => prev.filter((n) => n !== clName));
    }
  };

  const handleAddChecklist = () => {
    const name = newChecklistInput.trim() || `Checklist ${checklistNames.length + 1}`;
    if (!checklistNames.includes(name)) {
      setChecklistNamesState((prev) => [...prev, name]);
    }
    setNewChecklistInput("");
    setShowAddChecklist(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-[880px] max-h-[92vh] overflow-hidden p-0">
          {/* Header — Title is the focal element. Mode + actions sit above it as a thin chrome strip. */}
          <DialogHeader className="px-7 pt-4 pb-3 border-b">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {isEditing ? "Edit ticket" : "New ticket"}
                {isEditing && board.columns[form.statusId] && (
                  <>
                    <span className="mx-1.5 text-muted-foreground/40">·</span>
                    {board.columns[form.statusId].title}
                  </>
                )}
              </span>
              <div className="flex items-center gap-0.5 shrink-0">
                {isEditing && (
                  <>
                    <Button variant="ghost" size="icon-sm" onClick={onCopy} className="cursor-pointer" aria-label="Copy ticket"><CopyIcon className="h-3.5 w-3.5" /></Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" className="cursor-pointer" aria-label="More actions"><MoreHorizontalIcon className="h-3.5 w-3.5" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem variant="destructive" onClick={onDelete} className="cursor-pointer">
                          <Trash2Icon className="h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
                <Button variant="ghost" size="icon-sm" onClick={onClose} className="cursor-pointer" aria-label="Close"><XIcon className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
            <DialogTitle className="sr-only">{isEditing ? "Edit ticket" : "New ticket"}</DialogTitle>
            <DialogDescription className="sr-only">
              {isEditing ? "Update details, checklists, and attachments" : "Create a new ticket"}
            </DialogDescription>
            <Input
              placeholder="Ticket title"
              value={form.title}
              onChange={(e) => onChange({ title: e.target.value })}
              className="mt-1 h-auto border-0 bg-transparent px-0 py-1 text-lg font-semibold leading-tight shadow-none focus-visible:ring-0 focus-visible:border-b focus-visible:border-foreground/30"
              autoFocus
            />
          </DialogHeader>

          {/* Two-column layout */}
          <div className="flex overflow-hidden" style={{ maxHeight: "calc(92vh - 170px)" }}>
            {/* ── Main column (left) — primary content with breathing room ─── */}
            <div className="flex-1 overflow-y-auto px-7 py-6 flex flex-col gap-8 min-w-0">
              {/* Description */}
              <div className="flex flex-col gap-2">
                <Label className="text-xs font-medium text-foreground/70 flex items-center gap-1.5">
                  <FileTextIcon className="size-3" /> Description
                </Label>
                <Textarea
                  placeholder="Add a more detailed description..."
                  value={form.description}
                  onChange={(e) => onChange({ description: e.target.value })}
                  rows={7}
                  className="resize-y text-sm min-h-[150px] leading-relaxed"
                />
              </div>

              {/* Checklists */}
              <div className="flex flex-col gap-4">
                {checklistNames.map((clName) => {
                  const clItems = activeItems.filter((i) => i.checklistName === clName);
                  const done = clItems.filter((i) => i.completed).length;
                  const total = clItems.length;
                  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                  const draft = draftsByChecklist[clName] ?? "";
                  const isEditingName = editingChecklistName === clName;

                  return (
                    <div key={clName} className="flex flex-col gap-2">
                      {/* Checklist header */}
                      <div className="flex items-center gap-2">
                        <CheckSquareIcon className="size-3.5 text-muted-foreground shrink-0" />
                        {isEditingName ? (
                          <Input
                            autoFocus
                            value={checklistNameDraft}
                            onChange={(e) => setChecklistNameDraft(e.target.value)}
                            className="h-6 text-xs font-semibold flex-1 px-1"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); handleFinishRename(clName); }
                              if (e.key === "Escape") setEditingChecklistName(null);
                            }}
                            onBlur={() => handleFinishRename(clName)}
                          />
                        ) : (
                          <button
                            className="text-xs font-semibold text-foreground flex-1 text-left hover:text-primary transition-colors cursor-pointer"
                            onClick={() => { setEditingChecklistName(clName); setChecklistNameDraft(clName); }}
                          >
                            {clName}
                          </button>
                        )}
                        <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
                          {done}/{total}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-5 cursor-pointer shrink-0"
                          onClick={() => handleDeleteChecklist(clName)}
                        >
                          <XIcon className="size-3 text-muted-foreground" />
                        </Button>
                      </div>

                      {/* Progress bar */}
                      {total > 0 && (
                        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}

                      {/* Items */}
                      {clItems.length > 0 && (
                        <div className="rounded-lg border divide-y">
                          {clItems.map((item) => (
                            <div key={item.id} className="group flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors">
                              <Checkbox
                                checked={item.completed}
                                onCheckedChange={(c) => {
                                  if (isEditing) {
                                    onToggleSubtask(item.id, Boolean(c));
                                  } else {
                                    setLocalItems((prev) =>
                                      prev.map((i) => i.id === item.id ? { ...i, completed: Boolean(c) } : i),
                                    );
                                  }
                                }}
                              />
                              <span className={cn("flex-1 text-sm", item.completed && "line-through text-muted-foreground")}>
                                {item.title}
                              </span>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="size-6 cursor-pointer opacity-0 group-hover:opacity-100"
                                onClick={() => {
                                  if (isEditing) {
                                    onDeleteSubtask(item.id);
                                  } else {
                                    setLocalItems((prev) => prev.filter((i) => i.id !== item.id));
                                  }
                                }}
                              >
                                <XIcon className="size-3 text-muted-foreground" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Per-checklist add item */}
                      <div className="flex gap-2">
                        <Input
                          value={draft}
                          onChange={(e) => setDraftsByChecklist((prev) => ({ ...prev, [clName]: e.target.value }))}
                          placeholder="Add item..."
                          className="h-8 text-sm flex-1"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && draft.trim()) {
                              e.preventDefault();
                              handleAddItem(clName);
                            }
                          }}
                        />
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-8 cursor-pointer"
                          onClick={() => handleAddItem(clName)}
                        >
                          Add
                        </Button>
                      </div>
                    </div>
                  );
                })}

                {/* Add checklist */}
                {showAddChecklist ? (
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      value={newChecklistInput}
                      onChange={(e) => setNewChecklistInput(e.target.value)}
                      placeholder="Checklist name..."
                      className="h-8 text-sm flex-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); handleAddChecklist(); }
                        if (e.key === "Escape") { setNewChecklistInput(""); setShowAddChecklist(false); }
                      }}
                    />
                    <Button size="sm" variant="secondary" className="h-8 cursor-pointer" onClick={handleAddChecklist}>
                      Add
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 cursor-pointer"
                      onClick={() => { setNewChecklistInput(""); setShowAddChecklist(false); }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs cursor-pointer self-start"
                    onClick={() => setShowAddChecklist(true)}
                  >
                    <PlusIcon className="size-3 mr-1" /> Add checklist
                  </Button>
                )}
              </div>

              {/* Attachments */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-foreground/70 flex items-center gap-1.5">
                    <PaperclipIcon className="size-3" /> Attachments
                  </Label>
                  <input ref={attachRef} type="file" className="hidden" multiple
                    onChange={(e) => { if (mode === "create") { if (e.target.files?.length) setCreateFiles((p) => [...p, ...Array.from(e.target.files!)]); } else onUploadAttachments(e.target.files); e.currentTarget.value = ""; }} />
                  <Button variant="ghost" size="sm" className="h-6 text-[10px] cursor-pointer" onClick={() => attachRef.current?.click()}>
                    <PlusIcon className="size-3" /> Add
                  </Button>
                </div>

                {mode === "create" && createFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {createFiles.map((f, i) => (
                      <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-xs">
                        <FileIcon className="size-3 text-muted-foreground" />
                        <span className="truncate max-w-[120px]">{f.name}</span>
                        <button onClick={() => setCreateFiles((p) => p.filter((_, j) => j !== i))} className="cursor-pointer"><XIcon className="size-3" /></button>
                      </div>
                    ))}
                  </div>
                )}

                {isEditing && attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {attachments.map((att) => {
                      const mime = att.mimeType || "application/octet-stream";
                      const url = att.url || "";
                      const isImage = mime.startsWith("image/");
                      const isPdf = mime === "application/pdf";
                      const isPreviewable = isImage || isPdf;
                      const isDataUrl = url.startsWith("data:");
                      const downloadUrl = isDataUrl
                        ? url
                        : url.includes("/api/files?")
                          ? `${url}&download=1`
                          : url;

                      return (
                        <div key={att.id} className="flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-xs">
                          {isImage ? <ImageIcon className="size-3 text-muted-foreground" /> : <FileIcon className="size-3 text-muted-foreground" />}
                          <span className="truncate max-w-[120px]">{att.name}</span>
                          <span className="text-muted-foreground">{fmtBytes(att.size)}</span>
                          {isPreviewable && (
                            <button
                              onClick={() => {
                                if (isImage) setPreviewAtt(att);
                                else window.open(url, "_blank");
                              }}
                              className="cursor-pointer"
                            >
                              <EyeIcon className="size-3" />
                            </button>
                          )}
                          <a href={downloadUrl} download={att.name} target="_blank" rel="noopener noreferrer"><DownloadIcon className="size-3" /></a>
                          <button onClick={() => onDeleteAttachment(att.id)} className="cursor-pointer"><Trash2Icon className="size-3 text-destructive" /></button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Comments (edit only) */}
              {isEditing && (
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-medium text-foreground/70 flex items-center gap-1.5">
                    <SquarePenIcon className="size-3" /> Comments
                  </Label>
                  {(() => {
                    // Detect an active `@<partial>` token at the caret so we can suggest assignees.
                    // Simpler than full caret-tracking: match the last `@…` token at end of draft.
                    const match = commentDraft.match(/(^|\s)@([^\s@]{0,40})$/);
                    const partial = match ? match[2].toLowerCase() : null;
                    const suggestions = match
                      ? assignees
                          .filter((a) =>
                            partial === ""
                              ? Boolean(a.email)
                              : a.name.toLowerCase().includes(partial!) && Boolean(a.email),
                          )
                          .slice(0, 6)
                      : [];
                    const pick = (name: string) => {
                      const before = commentDraft.replace(/(^|\s)@([^\s@]{0,40})$/, (_m, lead) => `${lead}@${name} `);
                      onCommentDraftChange(before);
                    };
                    return (
                      <>
                        <div className="flex gap-2">
                          <Input
                            value={commentDraft}
                            onChange={(e) => onCommentDraftChange(e.target.value)}
                            placeholder="Write a comment... use @name to mention"
                            className="h-8 text-sm flex-1"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && commentDraft.trim() && suggestions.length === 0) {
                                e.preventDefault();
                                onAddComment();
                              }
                              if (e.key === "Enter" && suggestions.length > 0) {
                                e.preventDefault();
                                pick(suggestions[0].name);
                              }
                            }}
                          />
                          <Button size="icon-sm" variant="ghost" onClick={onAddComment} disabled={!commentDraft.trim()} className="h-8 w-8 cursor-pointer">
                            <SendHorizonalIcon className="size-3.5" />
                          </Button>
                        </div>
                        {suggestions.length > 0 && (
                          <div className="rounded-md border bg-popover p-1 shadow-sm">
                            {suggestions.map((a, idx) => (
                              <button
                                key={a.id}
                                type="button"
                                onClick={() => pick(a.name)}
                                className={cn(
                                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent",
                                  idx === 0 && "bg-accent/40",
                                )}
                              >
                                <span
                                  className="flex size-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                                  style={{ backgroundColor: a.color }}
                                >
                                  {a.initials}
                                </span>
                                <span className="flex-1 truncate">{a.name}</span>
                                {a.email && (
                                  <span className="truncate text-[10px] text-muted-foreground">{a.email}</span>
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {comments.length > 0 && (
                    <ScrollArea className="max-h-[160px]">
                      <div className="space-y-1.5">
                        {comments.map((c) => (
                          <div key={c.id} className="flex items-start gap-2 rounded-md border bg-muted/10 p-2">
                            <Avatar className="size-5 mt-0.5"><AvatarFallback className="text-[8px]">{initials(c.authorName)}</AvatarFallback></Avatar>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-medium">{c.authorName}</span>
                                <span className="text-[9px] text-muted-foreground">{formatDate(c.createdAt)}</span>
                              </div>
                              <p className="text-xs text-foreground/80 whitespace-pre-wrap">{c.content}</p>
                            </div>
                            <button onClick={() => onDeleteComment(c.id)} className="cursor-pointer shrink-0"><Trash2Icon className="size-3 text-destructive/50" /></button>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              )}

              {/* Documents (edit only) */}
              {isEditing && form.id && (
                <TicketDocumentsSection ticketId={form.id} />
              )}

              {/* Activity + Agent Output (edit only) */}
              {isEditing && activity.length > 0 && (
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setShowActivity(!showActivity)}
                    className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 cursor-pointer hover:text-foreground transition-colors"
                  >
                    <ZapIcon className="size-3" /> Activity & Output ({activity.length})
                    <span className="text-[9px]">{showActivity ? "▲" : "▼"}</span>
                  </button>
                  {showActivity && (
                    <ScrollArea className="max-h-[400px]">
                      <div className="space-y-2">
                        {activity.map((e) => {
                          const isAgentOutput = e.source !== "Worker" && e.source !== "Tasks" && e.event === "Agent response";
                          const isError = e.level === "error";
                          const isPlan = e.event === "Plan generated" || e.event === "Plan ready";
                          const hasDetails = Boolean(e.details?.trim());
                          const levelBorder = isError
                            ? "border-l-destructive"
                            : e.level === "success"
                              ? "border-l-emerald-500"
                              : e.level === "warning"
                                ? "border-l-amber-500"
                                : "border-l-blue-500";
                          return (
                            <div
                              key={e.id}
                              className={cn(
                                "rounded-lg border border-border/40 bg-muted/10 px-3 py-2 border-l-[3px]",
                                levelBorder,
                              )}
                            >
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  {isAgentOutput && <BotIcon className="size-3 text-primary shrink-0" />}
                                  {isPlan && <ListIcon className="size-3 text-primary shrink-0" />}
                                  <span className={cn(
                                    "text-[11px] font-semibold truncate",
                                    isError ? "text-destructive" : isAgentOutput ? "text-primary" : "text-foreground/80",
                                  )}>
                                    {e.event}
                                  </span>
                                  {e.source && e.source !== "Tasks" && (
                                    <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 shrink-0">
                                      {e.source}
                                    </Badge>
                                  )}
                                </div>
                                <span className="text-[9px] text-muted-foreground shrink-0">{formatDate(e.occurredAt)}</span>
                              </div>

                              {e.actorName && (
                                <p
                                  className="text-[10px] text-muted-foreground/80 mb-0.5"
                                  title={e.actorEmail || undefined}
                                >
                                  by <span className="font-medium text-foreground/70">{e.actorName}</span>
                                </p>
                              )}

                              {hasDetails && (isAgentOutput || isPlan) ? (
                                <div className="rounded-md bg-card border p-3 mt-1.5">
                                  <ActivityMarkdown text={e.details} />
                                </div>
                              ) : hasDetails ? (
                                <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5 whitespace-pre-wrap break-words line-clamp-4">
                                  {e.details}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              )}
            </div>

            {/* ── Sidebar (right) — Trello style ─────────────────── */}
            <div className="w-[240px] shrink-0 border-l bg-muted/[0.04] px-5 py-6 overflow-y-auto">
              {/* ── Status group ───────────────────────────────────── */}
              <SectionHeader>Status</SectionHeader>
              <div className="flex flex-col gap-3 mb-8">
                <Field label="List">
                  <Select value={form.statusId} onValueChange={(v) => onChange({ statusId: v })}>
                    <SelectTrigger className="h-8 text-xs w-full cursor-pointer"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {board.columnOrder.map((colId) => <SelectItem key={colId} value={colId}>{board.columns[colId]?.title}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Priority">
                  <Select value={form.priority} onValueChange={(v) => onChange({ priority: v as TicketDetailsForm["priority"] })}>
                    <SelectTrigger className="h-8 text-xs w-full cursor-pointer"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TICKET_PRIORITY_OPTIONS.map((o) => (
                        <SelectItem key={o.key} value={o.key}>
                          <span className="flex items-center gap-1.5">
                            <span className={cn(
                              "size-1.5 rounded-full shrink-0",
                              o.key === "low" && "bg-emerald-500",
                              o.key === "medium" && "bg-amber-500",
                              o.key === "high" && "bg-orange-500",
                              o.key === "urgent" && "bg-rose-600",
                            )} />
                            {o.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              {/* ── Schedule group ─────────────────────────────────── */}
              <SectionHeader>Schedule</SectionHeader>
              <div className="flex flex-col gap-3 mb-8">
                <Field label="Due date">
                  <Input
                    type="date"
                    value={(form.dueDate || form.scheduledFor || "").slice(0, 10)}
                    onChange={(e) => onChange({ dueDate: e.target.value, scheduledFor: e.target.value })}
                    className="h-8 text-xs"
                  />
                </Field>
              </div>

              {/* ── People & tags group ────────────────────────────── */}
              <SectionHeader>People &amp; tags</SectionHeader>
              <div className="flex flex-col gap-4">
                <Field label="Assignees">
                  {assignees.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground/80">
                      Open <span className="font-medium text-foreground">Board ▸ Manage assignees</span> first.
                    </p>
                  ) : (() => {
                    const selectedAssignees = assignees.filter((a) => form.assigneeIds.includes(a.id));
                    return (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="flex h-8 w-full items-center gap-2 rounded-md border bg-background px-2.5 text-left text-xs transition-colors hover:bg-accent"
                          >
                            {selectedAssignees.length === 0 ? (
                              <span className="text-muted-foreground">Assign people</span>
                            ) : (
                              <div className="flex flex-1 flex-wrap items-center gap-2 overflow-hidden">
                                {selectedAssignees.slice(0, 2).map((a) => (
                                  <span key={a.id} className="inline-flex items-center gap-1.5">
                                    <span className="inline-block size-2 rounded-full" style={{ backgroundColor: a.color }} />
                                    <span className="truncate max-w-[80px]">{a.name}</span>
                                  </span>
                                ))}
                                {selectedAssignees.length > 2 && (
                                  <span className="text-[10px] text-muted-foreground">+{selectedAssignees.length - 2}</span>
                                )}
                              </div>
                            )}
                            <span className="ml-auto text-[10px] text-muted-foreground/60">▾</span>
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-[260px]">
                          {assignees.map((a) => {
                            const checked = form.assigneeIds.includes(a.id);
                            return (
                              <DropdownMenuCheckboxItem
                                key={a.id}
                                checked={checked}
                                onCheckedChange={() => {
                                  const next = checked
                                    ? form.assigneeIds.filter((id) => id !== a.id)
                                    : [...form.assigneeIds, a.id];
                                  onChange({ assigneeIds: next });
                                }}
                                onSelect={(e) => e.preventDefault()}
                              >
                                <span className="flex items-center gap-2">
                                  <span className="inline-block size-2.5 rounded-full" style={{ backgroundColor: a.color }} />
                                  <span className="truncate">{a.name}</span>
                                  {a.email && <span className="ml-auto truncate text-[10px] text-muted-foreground">{a.email}</span>}
                                </span>
                              </DropdownMenuCheckboxItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    );
                  })()}
                </Field>

                <Field label="Labels">
                  {labels.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground/80">
                      Open <span className="font-medium text-foreground">Board ▸ Manage labels</span> first.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {labels.map((l) => {
                        const selected = form.labelIds.includes(l.id);
                        return (
                          <button
                            key={l.id}
                            type="button"
                            onClick={() => {
                              const next = selected
                                ? form.labelIds.filter((id) => id !== l.id)
                                : [...form.labelIds, l.id];
                              onChange({ labelIds: next });
                            }}
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium text-white transition-opacity",
                              selected ? "opacity-100 ring-2 ring-offset-1 ring-foreground/40" : "opacity-50 hover:opacity-80",
                            )}
                            style={{ backgroundColor: l.color }}
                            aria-pressed={selected}
                            title={selected ? `Remove ${l.name}` : `Add ${l.name}`}
                          >
                            {l.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </Field>

                <Field label="Tags">
                  <Input
                    value={form.tagsText}
                    onChange={(e) => onChange({ tagsText: e.target.value })}
                    placeholder="comma-separated"
                    className="h-8 text-xs"
                  />
                </Field>
              </div>
            </div>
          </div>

          {/* Footer */}
          <DialogFooter className="px-7 py-3 border-t">
            {isEditing && form.id && boardId && (
              <Button
                variant="ghost"
                size="sm"
                className="mr-auto gap-1.5 text-xs text-muted-foreground"
                onClick={() => {
                  if (typeof window === "undefined") return;
                  const url = `${window.location.origin}/boards?board=${boardId}&ticket=${form.id}`;
                  void navigator.clipboard?.writeText(url);
                }}
                title="Copy link to this ticket"
              >
                <LinkIcon className="size-3.5" />
                Copy link
              </Button>
            )}
            <Button
              onClick={() => {
                if (mode === "create") {
                  onSave(createFiles, localItems.map((i) => ({ checklistName: i.checklistName, title: i.title })));
                } else {
                  onSave();
                }
              }}
              className="gap-1.5 cursor-pointer"
            >
              <ClipboardListIcon className="size-3.5" />
              {isEditing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image preview */}
      <Dialog open={Boolean(previewAtt)} onOpenChange={(o) => { if (!o) setPreviewAtt(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{previewAtt?.name}</DialogTitle>
            <DialogDescription>Image preview</DialogDescription>
          </DialogHeader>
          {previewAtt && (
            <div className="relative h-[70vh] w-full">
              <Image
                src={previewAtt.url}
                alt={previewAtt.name}
                fill
                unoptimized
                className="object-contain rounded-md"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
