"use client";

import { useEffect, useState } from "react";

export type AuthUser = {
  sub: string;
  name: string;
  email: string;
};

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [role, setRole] = useState<"admin" | "member" | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { ok: boolean; user?: AuthUser; role?: "admin" | "member" } | null) => {
        setUser(data?.user ?? null);
        setRole(data?.role ?? null);
      })
      .catch(() => { setUser(null); setRole(null); })
      .finally(() => setLoading(false));
  }, []);

  return { user, role, loading };
}
