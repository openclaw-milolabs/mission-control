"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { NotificationProvider } from "@/components/providers/notification-provider";
import { ModulesProvider } from "@/components/modules/modules-provider";

function StartupEventHook() {
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    const fired = sessionStorage.getItem("mission-control-startup-event-fired");
    if (fired) return;
    sessionStorage.setItem("mission-control-startup-event-fired", "1");

    const payload = {
      runtimeAgentId: "main",
      agentId: "main",
      level: "info",
      type: "system",
      eventType: "system.startup",
      message: "Mission Control session startup",
      channelType: "internal",
    };

    void fetch("/api/agent/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {
      sessionStorage.removeItem("mission-control-startup-event-fired");
    });
  }, []);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const disableGlobalRealtime = pathname?.startsWith("/processes") ?? false;

  return (
    <ThemeProvider>
      <ModulesProvider>
        {!disableGlobalRealtime ? <StartupEventHook /> : null}
        {!disableGlobalRealtime ? <NotificationProvider /> : null}
        {children}
      </ModulesProvider>
    </ThemeProvider>
  );
}
