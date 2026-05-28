"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trash2Icon, PencilIcon, PlusIcon, XIcon, CheckIcon } from "lucide-react";
import type { Assignee } from "@/types/tasks";

const SWATCHES = [
  "#5B7CF6", "#55A07A", "#F0A64F", "#EA6C73", "#8A7FF6",
  "#22D3EE", "#A78BFA", "#F472B6", "#F59E0B", "#10B981",
  "#64748B", "#0EA5E9",
];

type Props = {
  open: boolean;
  boardName: string;
  assignees: Assignee[];
  onCreate: (name: string, color: string) => Promise<{ ok: boolean; error?: string }>;
  onUpdate: (assigneeId: string, name: string, color: string) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (assigneeId: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
};

export function ManageAssigneesModal({ open, boardName, assignees, onCreate, onUpdate, onDelete, onClose }: Props) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(SWATCHES[0]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(SWATCHES[0]);

  useEffect(() => {
    if (!open) {
      setName("");
      setColor(SWATCHES[0]);
      setError("");
      setEditingId(null);
    }
  }, [open]);

  const handleAdd = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError("");
    const result = await onCreate(trimmed, color);
    setBusy(false);
    if (!result.ok) {
      setError(result.error || "Failed to add assignee.");
      return;
    }
    setName("");
    setColor(SWATCHES[0]);
  };

  const startEdit = (a: Assignee) => {
    setEditingId(a.id);
    setEditName(a.name);
    setEditColor(a.color);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setError("");
  };

  const commitEdit = async () => {
    if (!editingId) return;
    const trimmed = editName.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError("");
    const result = await onUpdate(editingId, trimmed, editColor);
    setBusy(false);
    if (!result.ok) {
      setError(result.error || "Failed to update assignee.");
      return;
    }
    setEditingId(null);
  };

  const handleDelete = async (assigneeId: string) => {
    setBusy(true);
    setError("");
    const result = await onDelete(assigneeId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error || "Failed to delete assignee.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Manage assignees</DialogTitle>
          <DialogDescription>
            Custom assignees for <span className="font-medium text-foreground">{boardName}</span>. They can be attached to tickets on this board.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="ma-name" className="mb-1.5 block text-xs">Name</Label>
                <Input
                  id="ma-name"
                  placeholder="e.g. Alex Rivera"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleAdd(); }}
                />
              </div>
              <Button onClick={() => void handleAdd()} disabled={busy} size="sm" className="gap-1.5">
                <PlusIcon className="h-4 w-4" /> Add
              </Button>
            </div>
            <div className="mt-2">
              <Label className="mb-1.5 block text-xs">Color</Label>
              <div className="flex flex-wrap gap-1.5">
                {SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={`Color ${swatch}`}
                    onClick={() => setColor(swatch)}
                    className="size-6 rounded-full border-2 transition-transform hover:scale-110"
                    style={{
                      backgroundColor: swatch,
                      borderColor: color === swatch ? "#0f172a" : "transparent",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="max-h-[280px] overflow-auto rounded-md border">
            {assignees.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No assignees yet. Add one above.
              </p>
            ) : (
              <ul className="divide-y">
                {assignees.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 px-3 py-2">
                    {editingId === a.id ? (
                      <>
                        <div className="flex flex-1 flex-col gap-1.5">
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void commitEdit();
                              if (e.key === "Escape") cancelEdit();
                            }}
                            className="h-8"
                          />
                          <div className="flex flex-wrap gap-1">
                            {SWATCHES.map((swatch) => (
                              <button
                                key={swatch}
                                type="button"
                                aria-label={`Color ${swatch}`}
                                onClick={() => setEditColor(swatch)}
                                className="size-5 rounded-full border-2"
                                style={{
                                  backgroundColor: swatch,
                                  borderColor: editColor === swatch ? "#0f172a" : "transparent",
                                }}
                              />
                            ))}
                          </div>
                        </div>
                        <Button size="icon-sm" variant="ghost" onClick={() => void commitEdit()} disabled={busy} aria-label="Save">
                          <CheckIcon className="h-4 w-4" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={cancelEdit} aria-label="Cancel">
                          <XIcon className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <div
                          className="flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
                          style={{ backgroundColor: a.color }}
                        >
                          {a.initials}
                        </div>
                        <span className="flex-1 truncate text-sm">{a.name}</span>
                        <Button size="icon-sm" variant="ghost" onClick={() => startEdit(a)} aria-label={`Edit ${a.name}`}>
                          <PencilIcon className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => void handleDelete(a.id)}
                          disabled={busy}
                          aria-label={`Delete ${a.name}`}
                        >
                          <Trash2Icon className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
