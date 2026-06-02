import { AppSidebar } from "@/components/layout/app-sidebar";
import { DashboardGreeting } from "@/components/dashboard/dashboard-greeting";
import { KanbanOverview } from "@/components/dashboard/kanban-overview";
import { DashboardTasksTable } from "@/components/dashboard/dashboard-tasks-table";
import { SectionCards } from "@/components/dashboard/section-cards";
import { SiteHeader } from "@/components/dashboard/site-header";
import { getDashboardOverview, getDashboardStats } from "@/lib/db/server-data";
import { getSession } from "@/lib/auth/session";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { PageReveal } from "@/components/ui/page-reveal";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  const [overview, stats] = await Promise.all([
    getDashboardOverview(session?.email ?? null),
    getDashboardStats(),
  ]);
  const firstName = session?.name?.trim().split(/\s+/)[0] ?? null;

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
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            <PageReveal label="Loading dashboard…" className="py-4 md:py-6">
              <div className="flex flex-col gap-4 md:gap-6">
                {/* Row 0: Greeting */}
                <div className="px-4 lg:px-6">
                  <DashboardGreeting
                    name={firstName}
                    openTickets={overview.totals.openTickets}
                    agendaEvents={overview.totals.agendaEvents}
                  />
                </div>

                {/* Row 1: Total counts */}
                <SectionCards
                  boards={stats.boards}
                  tickets={stats.tickets}
                  agendaEvents={stats.agendaEvents}
                  processes={stats.processes}
                  logs={stats.logs}
                />

                {/* Row 2: Kanban overview chart */}
                <KanbanOverview
                  data={overview.chart}
                  totalTickets={overview.totals.tickets}
                  agendaEvents={overview.totals.agendaEvents}
                />

                {/* Row 3: User's open tasks */}
                <DashboardTasksTable tasks={overview.tasks} />
              </div>
            </PageReveal>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
