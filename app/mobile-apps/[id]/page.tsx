import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppDetailClient } from "@/components/mobile-apps/app-detail-client";

export const dynamic = "force-dynamic";

export default async function MobileAppDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
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
          <AppDetailClient appId={id} />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
