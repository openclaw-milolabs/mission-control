"use client";

import { useEffect, useState } from "react";
import { IconAlertTriangle, IconBrandApple, IconBrandGooglePlay } from "@tabler/icons-react";

type StoreStatus = { enabled: boolean; configured: boolean; error: string | null };
type ConfigStatus = { google: StoreStatus; apple: StoreStatus };

/**
 * Warns the operator when a store is disabled or its credentials are missing.
 * Consumes /api/mobile-apps/config-status which only ever returns booleans +
 * a reason string — never secrets, paths, or key ids.
 */
export function StoreConfigBanner() {
  const [status, setStatus] = useState<ConfigStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/mobile-apps/config-status", { cache: "no-store" });
        const json = await res.json();
        if (!cancelled && json.ok) setStatus(json.stores as ConfigStatus);
      } catch {
        /* non-fatal: the banner just won't show */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  const messages: Array<{ icon: typeof IconBrandApple; label: string; text: string }> = [];
  const describe = (s: StoreStatus): string | null => {
    if (!s.enabled) return "disabled — set ENABLED=true in secrets.env to start syncing.";
    if (!s.configured) return s.error ?? "credentials missing in secrets.env.";
    return null;
  };
  const g = describe(status.google);
  if (g) messages.push({ icon: IconBrandGooglePlay, label: "Google Play", text: g });
  const a = describe(status.apple);
  if (a) messages.push({ icon: IconBrandApple, label: "App Store", text: a });

  if (messages.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <div className="mb-1 flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
        <IconAlertTriangle className="size-4" />
        Some stores aren’t syncing
      </div>
      <ul className="space-y-1">
        {messages.map((m) => (
          <li key={m.label} className="flex items-start gap-2 text-muted-foreground">
            <m.icon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <span className="font-medium text-foreground">{m.label}</span> is {m.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
