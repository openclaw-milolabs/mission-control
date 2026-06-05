"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export function AddAppDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [appleRef, setAppleRef] = useState("");
  const [googleRef, setGoogleRef] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const refs = [appleRef, googleRef].map((s) => s.trim()).filter(Boolean);
    if (refs.length === 0) {
      toast.error("Paste at least one App Store or Play Store URL/ID.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/mobile-apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined, refs }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Failed to add app");
      toast.success(`Added ${json.name}`);
      setOpen(false);
      setAppleRef("");
      setGoogleRef("");
      setName("");
      onAdded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add app");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add app</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a mobile app</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>App Store URL or ID</Label>
            <Input
              placeholder="https://apps.apple.com/us/app/id310633997"
              value={appleRef}
              onChange={(e) => setAppleRef(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Google Play URL or package</Label>
            <Input
              placeholder="https://play.google.com/store/apps/details?id=com.whatsapp"
              value={googleRef}
              onChange={(e) => setGoogleRef(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Display name (optional)</Label>
            <Input
              placeholder="Auto-detected if blank"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Adding…" : "Add app"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
