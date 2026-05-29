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
import { Label as UiLabel } from "@/components/ui/label";
import { Trash2Icon, PencilIcon, PlusIcon, XIcon, CheckIcon } from "lucide-react";
import type { Label } from "@/types/tasks";

const SWATCHES = [
  "#5B7CF6", "#55A07A", "#F0A64F", "#EA6C73", "#8A7FF6",
  "#22D3EE", "#A78BFA", "#F472B6", "#F59E0B", "#10B981",
  "#64748B", "#0EA5E9",
];

type Props = {
  open: boolean;
  boardName: string;
  labels: Label[];
  onCreate: (name: string, color: string) => Promise<{ ok: boolean; error?: string }>;
  onUpdate: (labelId: string, name: string, color: string) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (labelId: string) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
};

export function ManageLabelsModal({ open, boardName, labels, onCreate, onUpdate, onDelete, onClose }: Props) {
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
      setError(result.error || "Failed to add label.");
      return;
    }
    setName("");
    setColor(SWATCHES[0]);
  };

  const startEdit = (l: Label) => {
    setEditingId(l.id);
    setEditName(l.name);
    setEditColor(l.color);
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
      setError(result.error || "Failed to update label.");
      return;
    }
    setEditingId(null);
  };

  const handleDelete = async (labelId: string) => {
    setBusy(true);
    setError("");
    const result = await onDelete(labelId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error || "Failed to delete label.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Manage labels</DialogTitle>
          <DialogDescription>
            Colored labels for <span className="font-medium text-foreground">{boardName}</span>.
            Tickets can be assigned one or more labels and filtered by them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <UiLabel htmlFor="ml-name" className="mb-1.5 block text-xs">Name</UiLabel>
                <Input
                  id="ml-name"
                  placeholder="e.g. Backend"
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
              <UiLabel className="mb-1.5 block text-xs">Color</UiLabel>
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

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="max-h-[280px] overflow-auto rounded-md border">
            {labels.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No labels yet. Add one above.
              </p>
            ) : (
              <ul className="divide-y">
                {labels.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 px-3 py-2">
                    {editingId === l.id ? (
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
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-white"
                          style={{ backgroundColor: l.color }}
                        >
                          {l.name}
                        </span>
                        <span className="flex-1" />
                        <Button size="icon-sm" variant="ghost" onClick={() => startEdit(l)} aria-label={`Edit ${l.name}`}>
                          <PencilIcon className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => void handleDelete(l.id)}
                          disabled={busy}
                          aria-label={`Delete ${l.name}`}
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
