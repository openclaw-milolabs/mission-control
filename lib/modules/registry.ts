/**
 * Module registry. Declarative source of truth for what modules exist.
 *
 * Every Mission Control feature is either CORE (always on) or a toggleable
 * MODULE that can be enabled/disabled from /settings. State (enabled flag,
 * who toggled it) lives in `module_state`; this file defines what exists.
 *
 * Adding a new toggleable module:
 *   1. Append a ModuleDefinition entry below.
 *   2. Create a handler at lib/modules/handlers/<id>.ts implementing
 *      preview/cleanup/setup.
 *   3. Gate UI surfaces with useModules().isEnabled('<id>').
 *   4. Gate any API routes the module owns server-side with
 *      requireModuleEnabled('<id>') early in the handler.
 */

import {
  IconCalendar,
  IconChartBar,
  IconDashboard,
  IconFileText,
  IconListDetails,
  IconRobot,
  IconStack2,
} from "@tabler/icons-react";
import type { Icon as TablerIcon } from "@tabler/icons-react";

export type ModuleId =
  | "kanban"
  | "agenda"
  | "processes"
  | "documents"
  | "metrics"
  | "system";

export type ModuleDefinition = {
  id: ModuleId;
  name: string;
  description: string;
  icon: TablerIcon;
  /** Core modules cannot be disabled. Their toggle renders as a static CORE badge. */
  core: boolean;
  /** Sidebar entry. Omitted modules (e.g. "system") don't add a nav row. */
  nav?: { title: string; url: string };
  /** Tables exclusively owned by this module. Used by the cleanup handler. */
  tables: string[];
  /** On-disk paths (project-root relative). Wiped during cleanup. */
  paths?: string[];
};

export const MODULES: readonly ModuleDefinition[] = [
  {
    id: "kanban",
    name: "Kanban Boards",
    description:
      "Boards, lists, tickets, labels, assignees, comments, attachments, and @mention notifications.",
    icon: IconListDetails,
    core: true,
    nav: { title: "Boards", url: "/boards" },
    tables: [
      "boards",
      "columns",
      "tickets",
      "ticket_attachments",
      "ticket_subtasks",
      "ticket_comments",
      "ticket_activity",
      "ticket_documents",
      "board_assignees",
      "board_labels",
      "notifications",
    ],
  },
  {
    id: "agenda",
    name: "Agenda",
    description:
      "Scheduled and recurring events with the native OpenClaw cron engine.",
    icon: IconCalendar,
    core: true,
    nav: { title: "Agenda", url: "/agenda" },
    tables: [
      "agenda_events",
      "agenda_occurrences",
      "agenda_run_attempts",
      "agenda_event_processes",
    ],
  },
  {
    id: "processes",
    name: "Processes",
    description: "Reusable multi-step process templates and versions.",
    icon: IconStack2,
    core: true,
    nav: { title: "Processes", url: "/processes" },
    tables: ["processes", "process_versions", "process_steps"],
  },
  {
    id: "documents",
    name: "Documents",
    description:
      "Doc + code editor. Write any file (Markdown, HTML, JS, JSON, SQL, ...) and link them to Kanban tickets. Disabling permanently deletes all documents and audit history.",
    icon: IconFileText,
    core: false,
    nav: { title: "Documents", url: "/documents" },
    tables: ["documents", "document_audit"],
    paths: ["documents"],
  },
  {
    id: "metrics",
    name: "Metrics",
    description:
      "Custom SQL-backed charts against your external MySQL database (configured via ~/.config/openclaw/secrets.env). Paste a SELECT, pick a chart type, and switch windows daily / weekly / monthly / yearly. Disabling permanently deletes every saved chart and its run history; the external database is untouched.",
    icon: IconChartBar,
    core: false,
    nav: { title: "Metrics", url: "/metrics" },
    tables: ["metrics", "metric_runs"],
  },
  {
    id: "system",
    name: "System",
    description: "Dashboard, agents, file manager, logs, settings.",
    icon: IconDashboard,
    core: true,
    tables: [],
  },
] as const;

export function getModule(id: ModuleId): ModuleDefinition | undefined {
  return MODULES.find((m) => m.id === id);
}

export const TOGGLEABLE_MODULES = MODULES.filter((m) => !m.core);
