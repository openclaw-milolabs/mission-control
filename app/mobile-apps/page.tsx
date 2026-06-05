import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { MobileAppsClient } from "@/components/mobile-apps/mobile-apps-client";

export const dynamic = "force-dynamic";

export default function MobileAppsPage() {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 14)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" initialUser={null} />
      <SidebarInset className="h-svh md:h-[calc(100svh-1rem)] overflow-hidden min-h-0">
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
          <MobileAppsClient />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
