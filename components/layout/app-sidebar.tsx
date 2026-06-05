"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/hooks/use-auth"
import {
  IconDashboard,
  IconDeviceMobile,
  IconInnerShadowTop,
  IconListDetails,
  IconLogs,
  IconRobot,
  IconCalendar,
  IconStack2,
  IconSettings,
  IconFolder,
  IconFileText,
  IconChartBar,
} from "@tabler/icons-react"

import { NavMain } from "@/components/layout/nav-main"
import { NavActivity } from "@/components/layout/nav-activity"
import { NavUser } from "@/components/layout/nav-user"
import { NotificationsBell } from "@/components/notifications/notifications-bell"
import { useModules } from "@/components/modules/modules-provider"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { getDataAdapter } from "@/lib/db"
import packageJson from "../../package.json"
import { toast } from "sonner"

// `moduleId` ties an entry to a module in lib/modules/registry.ts.
// When a module is disabled, its nav entries are hidden client-side.
// Entries without a moduleId are always visible.
const NAV_ENTRIES = [
  { title: "Dashboard", url: "/dashboard", icon: IconDashboard },
  { title: "Boards", url: "/boards", icon: IconListDetails, moduleId: "kanban" },
  { title: "Documents", url: "/documents", icon: IconFileText, moduleId: "documents" },
  { title: "Metrics", url: "/metrics", icon: IconChartBar, moduleId: "metrics" },
  { title: "Mobile Applications", url: "/mobile-apps", icon: IconDeviceMobile, moduleId: "mobile-apps" },
  { title: "Agenda", url: "/agenda", icon: IconCalendar, moduleId: "agenda" },
  { title: "Processes", url: "/processes", icon: IconStack2, moduleId: "processes" },
  { title: "Agents", url: "/agents", icon: IconRobot },
  { title: "File Manager", url: "/file-manager", icon: IconFolder },
  { title: "System", url: "/logs", icon: IconLogs },
  { title: "Settings", url: "/settings", icon: IconSettings },
] as const;

const APP_VERSION = packageJson.version || "0.1.0"

type SidebarUser = {
  name: string
  email: string
  avatar: string
}

type AppSidebarProps = React.ComponentProps<typeof Sidebar> & {
  initialUser: SidebarUser | null
  showActivity?: boolean
}

export function AppSidebar({ initialUser, showActivity = true, ...props }: AppSidebarProps) {
  const router = useRouter()
  const { user: authUser } = useAuth()
  const { isEnabled } = useModules()
  const visibleNav = NAV_ENTRIES.filter((e) => !("moduleId" in e) || isEnabled(e.moduleId as string))

  const sessionUser: SidebarUser | null = authUser
    ? { name: authUser.name, email: authUser.email, avatar: "" }
    : initialUser

  const [user, setUser] = React.useState<SidebarUser | null>(sessionUser)
  const [instanceName, setInstanceName] = React.useState("")
  const [appVersion, setAppVersion] = React.useState("")
  const adapter = React.useMemo(() => getDataAdapter(), [])

  // Keep displayed user in sync with live session
  React.useEffect(() => {
    setUser(sessionUser)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser])

  React.useEffect(() => {
    setAppVersion(APP_VERSION)
  }, [])

  React.useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "getWorkerSettings" }),
          cache: "reload",
        })
        const json = await res.json()
        const next = String(json?.workerSettings?.instanceName || "Mission Control").trim() || "Mission Control"
        if (!cancelled) { setInstanceName(next); document.title = next; }
      } catch {
        if (!cancelled) setInstanceName("Mission Control")
      }
    })()

    const onNameChanged = (event: Event) => {
      const custom = event as CustomEvent<{ name?: string }>
      const next = String(custom.detail?.name || "Mission Control").trim() || "Mission Control"
      setInstanceName(next)
    }

    window.addEventListener("mc-instance-name-changed", onNameChanged as EventListener)
    return () => {
      cancelled = true
      window.removeEventListener("mc-instance-name-changed", onNameChanged as EventListener)
    }
  }, [])

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/session", { method: "DELETE" })
      // Clear MSAL token cache so Microsoft SSO doesn't silently re-authenticate
      Object.keys(sessionStorage)
        .filter(k => k.startsWith("msal."))
        .forEach(k => sessionStorage.removeItem(k))
      setUser(null)
      router.replace("/login")
      router.refresh()
      toast.success("Signed out")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to sign out."
      toast.error(message)
    }
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-1.5 pr-1.5">
              <SidebarMenuButton
                asChild
                className="data-[slot=sidebar-menu-button]:p-1.5! flex-1"
              >
                <a href="#">
                  <IconInnerShadowTop className="size-5!" />
                  <span className="text-base font-semibold">{instanceName || "\u00A0"}</span>
                </a>
              </SidebarMenuButton>
              <NotificationsBell />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={visibleNav} />
        {showActivity ? <NavActivity /> : null}
      </SidebarContent>
      <SidebarFooter>
        <span className="px-2 pb-2 text-xs text-muted-foreground">
          Version v{appVersion || "\u00A0"}
        </span>
        {user ? <NavUser user={user} onLogout={handleLogout} /> : null}
      </SidebarFooter>
    </Sidebar>
  )
}
