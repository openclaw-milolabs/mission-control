"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ShieldIcon, UserIcon, Trash2Icon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

type Role = "admin" | "member";

type AllowedUser = {
  email: string;
  role: Role;
  display_name: string | null;
  created_at: string;
  created_by_email: string | null;
  last_signed_in_at: string | null;
};

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function AllowedUsersSection({ currentEmail }: { currentEmail: string | null }) {
  const [users, setUsers] = useState<AllowedUser[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);

  // Add-user form
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("member");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");

  // Remove confirmation
  const [removeTarget, setRemoveTarget] = useState<AllowedUser | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/users", { cache: "reload" });
      if (res.status === 403) {
        setForbidden(true);
        setUsers([]);
        return;
      }
      if (!res.ok) return;
      const j = await res.json();
      if (j.ok) {
        setForbidden(false);
        setUsers(j.users || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const handleAdd = async () => {
    setAddError("");
    setAddBusy(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add", email: newEmail, role: newRole }),
      });
      const j = await res.json();
      if (!j.ok) {
        setAddError(j.error || "Failed to add user.");
        return;
      }
      toast.success(`Added ${newEmail}`);
      setNewEmail("");
      setNewRole("member");
      await reload();
    } finally {
      setAddBusy(false);
    }
  };

  const handleRoleChange = async (email: string, role: Role) => {
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "updateRole", email, role }),
    });
    const j = await res.json();
    if (j.ok) {
      toast.success(`Role updated for ${email}`);
      await reload();
    } else {
      toast.error(j.error || "Failed to update role");
    }
  };

  const handleRemove = async (email: string) => {
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "remove", email }),
    });
    const j = await res.json();
    if (j.ok) {
      toast.success(`Removed ${email}`);
      setRemoveTarget(null);
      await reload();
    } else {
      toast.error(j.error || "Failed to remove user");
    }
  };

  return (
    <section id="users">
      <div className="mb-6">
        <h2 className="text-lg font-semibold tracking-tight">Allowed users</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Only listed users can sign in to this Mission Control. <span className="font-medium text-foreground">Admins</span> can manage modules, services, system updates, and the file manager.
          <span className="font-medium text-foreground"> Members</span> get everyday access: boards, agenda, documents.
        </p>
      </div>

      {forbidden ? (
        <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
          You need the admin role to view this section.
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center rounded-xl border bg-card p-8 text-xs text-muted-foreground">
          <Loader2Icon className="mr-2 size-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {/* Add-user form */}
          <div className="mb-4 rounded-xl border bg-card p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Label htmlFor="au-email" className="mb-1.5 block text-xs">Email</Label>
                <Input
                  id="au-email"
                  type="email"
                  placeholder="alice@example.com"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                />
              </div>
              <div className="w-full sm:w-40">
                <Label htmlFor="au-role" className="mb-1.5 block text-xs">Role</Label>
                <Select value={newRole} onValueChange={(v) => setNewRole(v as Role)}>
                  <SelectTrigger id="au-role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={() => void handleAdd()} disabled={addBusy || !newEmail.includes("@")}>
                {addBusy ? "Adding…" : "Add user"}
              </Button>
            </div>
            {addError && <p className="mt-2 text-xs text-destructive">{addError}</p>}
          </div>

          {/* List */}
          <div className="rounded-xl border bg-card divide-y divide-border/60">
            {(users || []).length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">No users.</div>
            ) : (
              (users || []).map((u) => {
                const isMe = currentEmail && u.email.toLowerCase() === currentEmail.toLowerCase();
                return (
                  <div key={u.email} className="flex items-center gap-3 px-4 py-3">
                    <div className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-full",
                      u.role === "admin" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                    )}>
                      {u.role === "admin" ? <ShieldIcon className="size-4" /> : <UserIcon className="size-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{u.display_name || u.email}</p>
                        {isMe && (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                            you
                          </span>
                        )}
                      </div>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {u.email} · last signed in {relTime(u.last_signed_in_at)}
                      </p>
                    </div>
                    <Select
                      value={u.role}
                      onValueChange={(v) => void handleRoleChange(u.email, v as Role)}
                      disabled={Boolean(isMe)}
                    >
                      <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={Boolean(isMe)}
                      onClick={() => setRemoveTarget(u)}
                      title={isMe ? "You can't remove your own access" : `Remove ${u.email}`}
                    >
                      <Trash2Icon className="size-4 text-destructive/70" />
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => { if (!o) setRemoveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove access?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.email} will no longer be able to sign in to Mission Control. Their existing data (boards, tickets, documents) is unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => removeTarget && void handleRemove(removeTarget.email)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
