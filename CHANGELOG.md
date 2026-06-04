# Changelog

All notable changes to Mission Control are documented here.


## [4.0.0] - 2026-06-04

### Added — Ticket links (URLs & local paths)

Kanban tickets could already link **internal documents**; they can now also link **external URLs** and **local file/folder paths**. The "Link" picker in the ticket modal is now tabbed:

- **Documents** — the existing internal documents tree picker, unchanged.
- **URL** — attach any `http`/`https` link with an optional friendly label (falls back to the site's hostname).
- **File / Folder** — attach a local path such as `M:\Altinstar\2026\AI`. Clicking it **opens the location in Windows File Explorer**.

Kanban ticket cards now show a **document icon with a count** in the meta row when a ticket has any linked documents or URL/path links, so attachments are visible at a glance without opening the ticket. The count is computed at board-load time (guarded so it's a no-op when the Documents module is disabled).

**How path-open works (and its setup):** browsers refuse to navigate to `file://` from an `http(s)` origin, and the open must happen on the **client** (your Windows PC), not the server — Mission Control commonly runs on a remote Linux host. So path links use a custom `mc-explorer:` URL scheme handled entirely on the Windows client. A one-time per-machine installer ([public/install-mc-explorer.ps1](public/install-mc-explorer.ps1), downloadable from the File/Folder tab) registers the scheme under `HKCU` (no admin needed) and drops a small helper that launches `explorer.exe`. After that, clicking a path link opens Explorer in one click **regardless of whether the server is on Linux or Windows**, as long as the clicking machine is Windows and can reach the path. Folders open directly; files open their containing folder with the file selected; a missing target pops a *"Path not found — is the drive connected?"* dialog.

- **Safety:** the helper only ever launches `explorer.exe` pointed at the path (it never executes the target file) and refuses anything that isn't an absolute drive/UNC path. The worst a rogue page invoking `mc-explorer:` could do is pop a File Explorer window.

### Added — API

- `app/api/tasks` actions `listTicketLinks`, `addTicketLink` (accepts `kind: "url" | "path"` with per-kind validation), `removeTicketLink`. All gated by the Documents module + authenticated session.
- New `public/install-mc-explorer.ps1` — one-time Windows client installer for the `mc-explorer:` protocol (install + `-Uninstall`).

### Database

- New `ticket_links` table (id, ticket_id, `kind` `'url'|'path'`, url, label, audit fields). Lives **under the Documents module** — created in its `setup`, dropped in its `cleanup` (so disabling Documents removes URL/path links too), and mirrored in [db/schema.sql](db/schema.sql) and the boot migration in [app/api/documents/route.ts](app/api/documents/route.ts). The Documents module's disable-preview now counts both document links and URL/path links.

### Notes

- No new runtime dependencies. The Documents module gates this feature; with it disabled the ticket "Documents & links" section hides entirely, as before.


## [3.9.0] - 2026-05-29

### Added — Metrics module

New toggleable module **`metrics`** under [Settings → Modules](app/settings). When enabled, exposes `/metrics`: a dashboard of custom SQL-backed charts that query the external MySQL configured in `~/.config/openclaw/secrets.env` (`MYSQL_HOST`, `MYSQL_USERNAME`, `MYSQL_PASS`, optional `MYSQL_DATABASE`/`MYSQL_PORT`).

- **Open authoring** (per the brainstorm pick): any signed-in user can create, edit, reorder, or delete metrics. Admin role isn't required for the module itself — only the toggle in Settings.
- **Chart types:** `bar`, `line`, `area` (single + stacked), `pie`, `donut`, `kpi` (big-number summary with first-to-last delta). All wrap the existing shadcn `Chart` primitive so colors inherit the active theme accent.
- **Time-window selector:** `Daily` / `Weekly` / `Monthly` / `Yearly` pills on the page header (global) and on each card (override). Server resolves the window into bind values `since`, `until`, and `bucket` (a MySQL `DATE_FORMAT` mask sized to the window) before substituting them into the saved SQL.
- **SQL placeholders:** users write `:since`, `:until`, `:bucket` directly in their query. We replace each with `?` and bind the matching value — no string concatenation, no injection surface.
- **Two-layer SQL safety:**
  - [lib/metrics/sql-guard.ts](lib/metrics/sql-guard.ts) parses every save: strips comments, rejects multi-statement, requires first keyword to be `SELECT` / `WITH` / `SHOW` / `DESCRIBE` / `EXPLAIN`, and refuses any of `INSERT/UPDATE/DELETE/REPLACE/DROP/ALTER/CREATE/TRUNCATE/RENAME/GRANT/REVOKE/CALL/LOAD/HANDLER/USE/SET/ATTACH/DETACH/EXEC/EXECUTE/PREPARE/DEALLOCATE/LOCK/UNLOCK/BEGIN/COMMIT/ROLLBACK/SAVEPOINT/START/CHANGE` even disguised by trailing comments. Length cap 10 000 chars.
  - We also report whether the configured MySQL user has write privileges (`SHOW GRANTS FOR CURRENT_USER()`) and surface a warning in the page banner if it does. **Recommended:** point `MYSQL_USERNAME` at a read-only user.
- **mysql2 connection pool** (5 connections, 60s idle timeout, keep-alive) with a 15 s statement timeout (`SET STATEMENT max_execution_time`) and a hard 50 000-row JS-side cap to protect against runaway `SELECT *`.
- **Editor:** Monaco SQL editor (reused from the Documents module) + side panel with name / description / chart type / X column / Y columns multi-select / default window. "Test query" button runs the SELECT through the same guard + bind path without saving, then auto-populates the column dropdowns from the result.
- **Per-card UX:** title, description, "27 rows · 4ms" metadata line, per-card window pills + refresh, kebab menu (Edit / Delete). Each card maintains a per-window in-memory cache; per-card refresh button bypasses it.
- **Health banner:** `GET /api/metrics/health` shows MySQL version, database name, and read-only-status; if credentials are missing the page renders a setup-instructions card pointing at the secrets file.
- **Per-run audit:** every executed metric writes a row to `metric_runs` with actor, window, status, error message, row count, and duration.

### Added — API

- `GET /api/metrics` — list saved metrics.
- `POST /api/metrics` — actions: `createMetric`, `updateMetric`, `deleteMetric`, `reorderMetrics`, `runMetric`, `previewSql` (ad-hoc, doesn't persist).
- `GET /api/metrics/health` — `pingMysql` plus version/grants/secrets-path metadata.
- All routes gated by `requireModuleEnabled("metrics")` and authenticated session.

### Database

- New `metrics` table (id, workspace_id, name, description, sql_text, chart_type, x_column, y_columns text[], default_window, position, audit fields).
- New `metric_runs` table (metric_id, ran_by_*, window, since/until, status, error_message, row_count, duration_ms, occurred_at) + per-metric `occurred_at desc` index.
- Boot-time setup in [lib/modules/handlers/metrics.ts](lib/modules/handlers/metrics.ts); canonical schema in [db/schema.sql](db/schema.sql).

### Dependencies

- `mysql2 ^3.11.0` added to `package.json`. Run `npm install` before `npm run build`. ~1.5 MB unzipped, server-only — no client bundle impact.

### Out of scope this release

- Multi-MySQL support (single `MYSQL_*` block).
- Querying Mission Control's own Postgres (everything is the external MySQL).
- Alerts ("notify when value crosses X").
- Scheduled refresh / cached metric snapshots.
- Catalog skill scripts (`scripts/metrics/*`).
- CSV export from cards.

## [3.8.0] - 2026-05-29

Security hardening release. **All listed CVE-class issues from the 3.7.0 audit are closed.** No data leaks left wide-open. Required follow-ups (ops-side) are called out at the bottom.

### Added — Security

- **User allowlist + roles.** New `allowed_users` table (email PK, role: `admin` | `member`). Auth at `/api/auth/session` now verifies the Azure AD id-token AND checks the user is on the allowlist before issuing a session — being in the tenant is no longer enough. **Bootstrap rule:** when the table is empty the first successful sign-in is auto-promoted to admin so a fresh install still works without DB surgery.
- **Settings → "Allowed users"** admin-only section. Add / remove users, change roles (admin / member). You can't demote or remove yourself.
- **CSRF Origin guard in [proxy.ts](proxy.ts).** All state-changing requests (POST / PUT / PATCH / DELETE) under `/api/*` must come from the same origin as the request itself; checked against `Origin`, falling back to `Referer`. Missing both → 403. Honours `X-Forwarded-Host` so reverse proxies still work.
- **`isAllowedAttachmentPath()`** export from [/api/files](app/api/files/route.ts). Used by `attachFileFromPath` so the same allow/deny rules apply on the write side, not just on read.
- **Boot-migration audit** scrubs any pre-existing `ticket_attachments` rows whose `path` points outside the new narrow allow-list. Idempotent (gated by `app_settings.attachment_paths_audited_at`).

### Changed — Security

- **`/api/files` allow-list narrowed** to `documents/`, `runtime-artifacts/`, `storage/` (under project root), plus `/tmp`. The previous list included `/home/clawdbot/.openclaw` which exposed `secrets/`, `agents/sessions/`, `.env`. A new deny-list rejects anything matching `.env*`, `secrets.env`, `*-token`, `session.json`, `id_rsa`, `id_ed25519`, or path fragments `/.openclaw/secrets/`, `/.openclaw/agents/`, `/.ssh/`, `/.aws/` even inside an allowed root.
- **`/api/files` no longer serves HTML or SVG inline.** Old behaviour: `Content-Disposition: inline` for any `text/*` or `image/*`. New behaviour: only known-safe types (`image/png|jpeg|gif|webp|x-icon`, `application/pdf`, `text/plain|markdown|csv`) render inline. HTML / SVG / JS / CSS attachments are always forced to `attachment`. Every response also gets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a tight `Content-Security-Policy: default-src 'none'; sandbox`. Stored XSS via attachment download is closed.
- **`uploadAttachment` rejects HTML/SVG outright** and caps payload size at 10 MB (was unbounded → DoS risk).
- **`attachFileFromPath`** now refuses any path outside the allow-list. Previously accepted any absolute path on the filesystem.
- **Admin gates** on every endpoint that touches infra:
  - `/api/services` POST (start/stop/restart) — admin
  - `/api/system` POST (update / rebuild / restart) — admin
  - `/api/modules` POST (enable / disable / previewDisable) — admin
  - `/api/file-manager` POST / PUT / DELETE (all mutating ops) — admin
  - `/api/users` GET + POST — admin
  - `/api/setup` POST refuses after `setup_completed=true` unless caller is admin (prevents anyone from flipping the setup flag back to lock everyone out).
- **`/api/file-manager` `getUidName` / `getGidName` switched from `execSync` template literals to `execFileSync` with an args array.** Numeric uid/gid was the only attacker-vector before, but the template literal would have been a shell-injection if anyone later passed a string. Defense in depth.
- **Boot-migration NOTICE spam silenced.** `ensureSchema` in `/api/documents` and the boot-migration block in `/api/tasks` now run once per process (cached in a `_*SchemaEnsured` flag). Previously every API hit re-ran every `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, which flooded `nextjs.log` with `42P07` / `42701` NOTICE messages and made real errors hard to find.

### Database

- New `allowed_users` table (`email` PK, `role`, `display_name`, `created_at`, `created_by_email`, `updated_at`, `last_signed_in_at`) + `allowed_users_role_idx`.
- New `app_settings.attachment_paths_audited_at` column gating a one-shot scrub of legacy rogue attachment paths.
- All migrations are idempotent in `db/schema.sql` and have boot safety nets in `lib/auth/roles.ts`.

### Required ops-side follow-ups (NOT codebase-fixable)

- `chmod 600 ~/.openclaw/workspace/mission-control/.env` so backup tooling can't accidentally include it.
- Rotate any credentials that were ever exposed via the old `/api/files` allow-list if anyone outside the Azure AD tenant could have hit the route. (Behind sameSite cookies + tenant-gated SSO this is very unlikely, but rotate to be safe.)
- Make sure the gateway token in `app_settings.gateway_token` was set by an admin, not an attacker mid-window.

### Audit trail

Every module enable / disable, services start / stop, attachment upload, and user-list change is recorded with `actor_email` + `actor_name` in `activity_logs`. The new allowed-users CRUD operations also update `allowed_users.last_signed_in_at` per sign-in so you can see who's actually using their access.

## [3.7.0] - 2026-05-29

### Added
- **Modular architecture.** Mission Control now has a "module" concept. **Core** modules (Kanban Boards, Agenda, Processes, System) are always on. **Toggleable** modules can be enabled or disabled from Settings. The first toggleable module is **Documents**.
- **Declarative module registry** at [lib/modules/registry.ts](lib/modules/registry.ts) — typed `MODULES` array declaring id, name, description, icon, core flag, optional nav entry, tables owned, on-disk paths. Adding a module is a code change; toggling is a DB write.
- **`module_state` table** keeps the enabled flag, who toggled it, and when. Defaults seed on first boot with `enabled=true` for every module — nothing disappears on the next deploy.
- **`/api/modules`** route — `GET` returns every module's metadata and current state, `POST { action: "previewDisable" | "disable" | "enable", moduleId }`. Disable preview returns counts (47 documents, 12 folders, 312 audit rows, 3 ticket links, 8.4 MB on disk) plus sample affected items.
- **Settings page → Modules section** with one card per module: icon, name, description, status badge (`Core` / `Enabled` / `Disabled`), toggle, last-toggle attribution ("Disabled by Cem · 5m ago"). Core modules show a disabled toggle and the `Core` badge.
- **Disable flow.** Toggling an enabled non-core module opens a dialog with the impact preview and a typed-confirmation input ("Type `documents` to confirm"). On confirm: filesystem wiped, tables dropped (FK cascade nukes `ticket_documents` link rows), state row updated, activity log entry written, modules cache invalidated. UI updates everywhere via the modules React context.
- **Enable flow.** One-click confirm — recreates the module's tables (idempotent) and on-disk paths, flips state, refreshes UI.
- **Cross-module gating.** A `useModules()` React context exposes `isEnabled(id)`; the sidebar, the `/documents` page, and the ticket modal's Documents section all gate themselves with it. Server-side `requireModuleEnabled` / `isModuleEnabled` helpers wrap API routes that own module data: `/api/documents/*` returns 503 when disabled, `/api/tasks` document actions (`listTicketDocuments`, `linkTicketDocument`, `unlinkTicketDocument`) become graceful no-ops so the ticket modal's Documents section silently hides.
- **Re-fetch on focus.** The modules provider re-pulls module state when the window regains focus, so a toggle in another tab updates the current tab without a manual refresh.

### Changed
- **Documents page empty state** now centers via a CSS grid layout — `grid h-full place-items-center` instead of the previous flex that wasn't being constrained by its parent. "No documents yet" now sits dead-center of the editor pane regardless of viewport height.
- **Recent-docs grid + link-document picker** share a unified file-row look: rounded icon tile + filename as title + parent folder path as description + meta line (size · time · who). The picker is a more compact variant of the same template.
- **Documents page redirects** to `/settings#modules` when the module is disabled (covers toggling in another tab while the page is open).

### Database
- New `module_state` table (`module_id`, `enabled`, `enabled_at`, `disabled_at`, `enabled_by_email/name`, `disabled_by_email/name`, `updated_at`).
- Idempotent boot migration auto-seeds known module ids with `enabled=true` on first request.

### Out of scope this release
- Module marketplace / install from catalog skill.
- Per-user module visibility.
- Module-to-module dependency graph (e.g. "Documents requires Kanban") — current Documents *integrates with* Kanban but doesn't *depend on* it.
- Snapshot-to-zip on disable for later restore (disable is permanent deletion).
- Catalog skill awareness of module state (currently the skill will see 503 with a clear message; structured awareness is a follow-up).

## [3.6.0] - 2026-05-29

### Added
- **New `/documents` surface** — a doc/code editor that creates and edits any file the user wants under `<project_root>/documents/` (parallel to `runtime-artifacts/`). Real files at real extensions; the DB tracks metadata + audit only. Hybrid editor: **Tiptap** WYSIWYG (StarterKit + Link + Underline + TaskList + Code blocks, toolbar with bold/italic/headings/lists/quotes/code/link/undo) for `.md/.html/.txt/.rtf`; **Monaco** (VS Code's editor) for `.js/.ts/.json/.yaml/.sql/.py/.css/.scss/.html/.md/...` with syntax highlighting + minimap. Dynamic-imported so the editor bundle only loads on this route.
- **Documents page UX.** Left sidebar with recursive folder tree (folder context menu: New file in here / New folder in here / Rename / Delete). Center area: breadcrumbs + Save button + Edit / Preview / History tabs. Right panel: file metadata + linked-tickets list. Recent-grid empty state shows the 12 most recently edited docs as cards. Ctrl/Cmd+S saves. Confirmation alert before delete. Renames + moves rewrite path prefixes for every descendant row.
- **Audit log per document.** New `document_audit` table records `created` / `updated` / `renamed` / `moved` / `deleted` / `folder_created` / `linked_to_ticket` / `unlinked_from_ticket` events with actor_name + actor_email + jsonb details. The History tab renders this with actor + relative time; `details.from → details.to` for renames/moves.
- **Many-to-many ticket ↔ document linking.** New `ticket_documents` join table (pointer-only). Ticket modal gets a new "Documents" section between Comments and Activity — lists linked docs with icon, path, last-edited-by, Open (jumps to `/documents`) and Unlink buttons. "+ Link document" opens a picker with the full document tree, multi-select checkboxes, full-text search across paths. Linking + unlinking both write to `ticket_activity` (so the board's live feed shows it) AND `document_audit` (so the doc's history shows it).
- **Sidebar navigation** entry for Documents (between Boards and Agenda).
- **API surface.**
  - `GET /api/documents` → workspace-wide tree walk (or `?path=<rel>` for one folder, or `?recent=1&limit=N` for the recent grid).
  - `GET /api/documents/content?path=<rel>` → file content as text (rejects binary heuristically and files > 4 MB).
  - `POST /api/documents` actions: `createFolder`, `createFile`, `updateContent`, `rename`, `move`, `deleteDoc`, `listAudit`, `listDocumentTickets`.
  - `POST /api/tasks` new actions: `listTicketDocuments`, `linkTicketDocument`, `unlinkTicketDocument`.
- **Mission Control catalog skill — Documents capability.** Ten new scripts under `scripts/documents/`: `list.js`, `read.js`, `create.js`, `update.js`, `rename.js`, `move.js`, `delete.js`, `history.js`, `link-ticket.js`, `unlink-ticket.js`. All mutations require `--confirm`. Names resolve via the same snapshot mechanism the boards scripts use. `manifest.json` gains 10 new capabilities; `policies/action-routing.json` gains 10 new `mission-control.documents.*` route entries.
- **Path safety.** A `lib/documents/fs.ts` helper centralises path sanitisation — rejects `..`, absolute paths, NULs/control chars, anything escaping the documents root. Dotfiles are hidden in listings.

### Changed
- **Ticket modal Assignees — chips → dropdown** with a colored dot per assignee. The dropdown trigger now shows the selected assignees as small pill-rows (color dot + name); opening it reveals the full list as checkbox items with color dots and email on the right. Less visual noise on tickets with many assignees; matches the new dropdown-heavy toolbar.
- **Ticket modal "Labels" free-text field renamed to "Tags".** Was confusingly called "Labels" but writes to `tagsText`/`tags`; the new per-board colored labels keep the "Labels" name.

### Database
- `documents (id, workspace_id, relative_path, kind, size_bytes, extension, created_by_email/name, last_edited_by_email/name, created_at, updated_at, unique(workspace_id, relative_path))` + 2 indexes.
- `document_audit (id, document_id, workspace_id, actor_email, actor_name, event, details jsonb, occurred_at)` + 2 indexes.
- `ticket_documents (ticket_id, document_id, linked_by_email/name, linked_at, pk(ticket_id, document_id))` + 1 index.
- All idempotent in `db/schema.sql` and as boot safety nets in `/api/documents/route.ts` and `/api/tasks/route.ts`.

### Dependencies
- Added: `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `@tiptap/extension-task-item`, `@tiptap/extension-task-list`, `@tiptap/extension-underline`, `@tiptap/extension-code-block-lowlight`, `lowlight`, `@monaco-editor/react`. Run `npm install` before `npm run dev` / `npm run build`.

### Out of scope this release
- Real-time collaborative editing (no Yjs/CRDT).
- Drag-and-drop file upload from desktop.
- Inline image upload (Tiptap uses URLs only).
- Per-doc permission overrides — every authenticated user reads and edits every doc; the audit log captures accountability.
- Trash / restore — delete is permanent (skill `--confirm` gate, UI alert dialog).

## [3.5.4] - 2026-05-29

### Added
- **Per-board labels with colour.** New `board_labels` table (id, board_id, name, color) plus `tickets.label_ids text[]`. New "Labels" button on the boards toolbar opens a Manage Labels modal (name + 12-color swatch, inline edit + delete with cascading removal from tickets). Ticket modal has a chip-style multi-select label picker; ticket cards show label chips at the top.
- **Filter by label and by due date.** Two new dropdowns on the workspace toolbar next to "Assignee": "Label" (multi-select with "Unlabeled" sentinel and "Clear filter") and "Due" (radio: All / Overdue / Today / This week / No due date). Filter sets combine with the existing search + assignee filter inside `filteredTicketIds` in `useTasks`.
- **Calendar view as a 4th ViewMode.** Month grid with prev / next / Today nav; up to three tickets visible per cell with overflow shown as "+N more"; each ticket cell shows the first label's color (or falls back to priority). Click to open the ticket. Routes alongside Kanban / List / Grid.
- **Shareable per-ticket URL.** Pasting `/boards?board=X&ticket=Y` opens the ticket once on mount and strips `?ticket=` from the URL after (preserves the 3.4.x "don't re-add on every click" fix). New "Copy link" button on the ticket modal footer writes the URL to the clipboard.
- **Notifications bell rebuilt with two segments.** Tab control between "Mentions" (count + Mark-all-read, the previous behavior) and "My tickets" (live list of every ticket whose `assignee_ids` contain a board assignee whose email matches your session). Empty state now diagnoses why — e.g. "No board assignee has the email <your-session-email>", with a pointer to the Assignees toolbar.
- **Notifications inbox now returns `assignedTickets[]` + `diagnostics`.** `/api/notifications/inbox` joins `board_assignees` on `lower(email) = lower(session.email)` and returns the resolved assignee ids plus all tickets where `assignee_ids && <those ids>`. Diagnostics carry `sessionEmail`, `hasMatchingAssignee`, `assigneeCountTotal`.
- **Activity feed polish.** Day-bucket headers (`Today` / `Yesterday` / `Mon, May 26`) for visual rhythm, tighter row padding, same icons and color tokens — no skeleton changes.

### Changed
- **Per-column cap removed.** Kanban columns no longer cap at 25 tickets; they scroll naturally inside the column's existing `ScrollArea`. Removed `Show more` / `Show less` UI and the `renderedTicketIdsByColumn` / `hiddenCountByColumn` plumbing.
- **Bell handles 401 distinctly** — when the bell hits an unauthenticated response, it shows "Sign in to see your inbox" instead of silently rendering "All caught up". Reload-on-open keeps the assigned tickets segment fresh.
- **Workspace toolbar collapsed from 7 buttons to 3.** The board toolbar got out of hand as features were added (Board, Assignees, Labels, Add, Label-filter, Due, Assignee-filter, Sort/View). It is now: `[Add ticket]` (primary CTA) · `Board ▾` (Add list, Manage assignees, Manage labels, Edit / Copy / Delete board) · `View ▾` (filter sub-menus for Assignee / Label / Due with active-count badges, plus Sort and View-mode radio groups). Aggregate filter count is shown on the View trigger so you can tell something is filtered without opening the menu; one "Clear all" affordance resets every filter. The new toolbar lives in `components/tasks/boards/workspace-toolbar.tsx`.

### Database
- New `board_labels` table + `board_id` index. `tickets.label_ids text[] not null default '{}'`.
- Migrations are idempotent and live in both `db/schema.sql` (canonical) and as boot safety nets in `app/api/tasks/route.ts`.

## [3.5.3] - 2026-05-29

### Added
- **Per-board custom assignees now carry an email.** `board_assignees` gained an `email` column. The Manage Assignees modal has a Name + Email side-by-side form, and the inline edit row exposes the same. Email is what ties a board assignee to a real logged-in user for @mentions.
- **@mention parsing in comments.** When you post a comment containing `@<assignee name>` (greedy longest-match against board assignees), the server resolves it via `extractMentions()` and inserts one row into the new `notifications` table per resolved email. Self-mentions are dropped. Comment input has an inline autocomplete dropdown — type `@` and matching board assignees with email show up; Enter or click inserts.
- **In-app notifications bell.** New bell icon in the app sidebar header with unread count badge. Popover shows recent mentions ("X mentioned you in <ticket>"), per-row read state with a blue dot, and a "Mark all read" action. Click a row to jump to the ticket via the existing `mc:open-ticket` event. Live updates over the existing `/api/events` SSE stream — new `notification` channel scoped per session email.
- **New API surfaces.** `GET /api/notifications/inbox` returns up to 30 rows scoped to `lower(session.email)` with unread count; `POST /api/notifications/inbox` accepts `markRead` / `markAllRead`. The inbox endpoint backfills `recipient_sub` on first read so future delivery can include the Azure AD subject.
- **Actor attribution on every audit log.** `ticket_activity` and `activity_logs` gained `actor_name` and `actor_email`. POST `/api/tasks` resolves the current session once and binds an `audit()` closure used by every event write, so board / list / ticket / assignee / move / delete events all carry the logged-in user's name. Ticket comments now persist the session user's name and `sub` instead of the hardcoded `Operator`. The board activity feed and the ticket modal's Activity tab render "by <name>" on each row.
- **Filter tickets by assignee.** New "Assignee" dropdown in the workspace toolbar with checkbox multi-select and color swatches. Includes a sentinel "Unassigned" option and a "Clear filter" action. Filter state combines with the existing search.
- **Per-list pagination on Kanban.** `useTasks` now caps each column to 25 rendered tickets by default with `Show N more` / `Show less` buttons in the column footer. Header counter shows `25 / 130` on capped columns. Prevents 130-ticket walls on busy boards.
- **Trello feature-gap research doc** at `docs/trello-feature-gap.md` — tiered comparison of Trello vs MC board surfaces (board / list / card / cross-cutting), ranked by user-pain × effort, with concrete recommended next-three after this sprint (per-board labels, archive-vs-delete, card watchers).

### Database
- New table `notifications` (workspace-scoped, email-recipient-scoped, with `read_at`, `kind`, actor + board / ticket / comment refs). Two indexes — one partial on unread rows, one on recent rows — both keyed by `lower(recipient_email)`.
- `board_assignees.email` text column + `lower(email)` partial index.
- `ticket_activity` and `activity_logs` gained `actor_name`, `actor_email`.
- All migrations are idempotent and exist in both `db/schema.sql` (canonical, applied by `update.sh` / `npm run db:migrate`) and as boot safety nets in `app/api/tasks/route.ts`.

## [3.5.2] - 2026-04-18

### Fixed
- **File manager "Open folder" link from Agenda was broken.** A previous attempt introduced a dual-root architecture (`home` vs `artifacts`) based on a mistaken assumption that `runtime-artifacts/` lived outside `~/.openclaw`. In reality the file manager's root is `/home/clawdbot/.openclaw` and `runtime-artifacts/` is already a subfolder inside it, so the dual-root plumbing produced "failed to load" errors when the agenda sheet linked to an artifact folder. Reverted the API route and the file-manager client back to a single-root model (`ROOT = /home/clawdbot/.openclaw`) and changed the agenda detail sheet to build its href by stripping the `/home/clawdbot/.openclaw` prefix from the artifact path, producing a relative link like `/file-manager?path=/runtime-artifacts/agenda/<evt>/occurrences/<occ>/artifacts`.
- **Agenda detail sheet "Output folder" card — replaced "Copy path" with "Open in file manager" button** that navigates to the artifact folder directly in the file manager instead of only copying the absolute disk path.

### Changed
- **Altinstar social post guides tightened (01-assets, 02-canvas, 00-how-to-use).** Hardened the mandatory asset rules so the generator can no longer invent, redraw, regenerate, or substitute decorative elements — every visual other than background/typography must come from a real file in the approved asset folders. Added an explicit "Asset Usage Workflow" with 5 ordered steps (enumerate folders, pick by filename, place unchanged, never enter a "create the asset" step). Canvas rules reinforced to exactly 1024 × 1024 px with no upscale/downscale/crop/pad fallbacks. A "Hard Start Gate" was added to the how-to guide requiring the agent to (1) read all five guides, (2) enumerate every asset folder's actual contents, (3) view the example banners, (4) locate the footer file, and (5) confirm 1024 × 1024 rendering — before any generation attempt.

- **Version bump** to 3.4.6.

## [3.4.5] - 2026-04-17

### Changed
- **Prompt template v2.4 — no-extra-files rule added.** A single new rule in the output-rules block instructs the agent to create only the files the request explicitly asks for — no scratch files, intermediate drafts, readmes, notes, or summary documents on its own initiative. The `response.md` contract line is reworded to make explicit that `response.md` is the single permitted extra file beyond what the request names. Motivated by a Match Day banner task where the agent was asked for four banners and produced ~20 ancillary files alongside them.
- **Version bump** to 3.4.5.

## [3.4.4] - 2026-04-17

### Added
- **Agenda detail sheet — "Identifiers" card in Overview.** New card shows the Event ID, plus the Occurrence ID for recurring series, each with an inline copy-to-clipboard button and a sonner toast confirmation. Replaces the small ID pill that previously lived next to the title, which was easy to miss and only exposed a truncated 8-char prefix.
- **Agenda detail sheet — "Output folder" card in Overview.** New card surfaces the on-disk artifact folder for the selected occurrence (computed from the first artifact file's parent path, so no extra round-trip to the server). Shows the folder basename as the card title, the full path below, and a "Copy path" button so the user can paste it into their OS file explorer. Hidden until the occurrence produces at least one file.

### Changed
- **Agenda detail sheet — ID removed from the title area.** The inline 8-char ID button next to the title/status badges is gone. IDs are now exposed through the dedicated Identifiers card where the full value is visible and copyable.
- **Version bump** to 3.4.4.

## [3.4.3] - 2026-04-17

### Fixed
- **Broken image previews in agenda detail sheet** — the artifacts API route served images with `Content-Disposition: attachment`, which combined with Next.js `<Image>` optimizer proxying made previews render as broken icons. Switched to `inline` disposition with a `private, max-age=60` cache header, replaced `<Image>` with a plain `<img>` (new `ArtifactImagePreview` component with graceful error fallback), and added `Uint8Array` body wrapping for Next 16 compatibility. Download button integrity preserved via the `<a download>` attribute which forces download on same-origin regardless of disposition.

### Added
- **File manager — image dimensions in preview details.** When previewing an image, the Details panel now shows a "Dimensions" row (e.g., `1920 × 1080`) alongside Size/Location/Created. Captured from `HTMLImageElement.naturalWidth`/`naturalHeight` via the existing `onLoad` handler; resets on preview close and hides for non-image files.

### Changed
- **Prompt template v2.3 — consolidated execution rules for clearer LLM comprehension.** The seven overlapping "don't do meta-commentary" bullets in `prompt-renderer.mjs` collapsed to three focused rules (start with the deliverable / skills and tools are silent implementation guidance / produce content directly). Output rules tightened similarly: merged the redundant "no labels" bullets and compressed the artifact-directory and `response.md` contract to one clear line each. Same semantics as v2.2, noticeably shorter and easier for the agent to parse.
- **Version bump** to 3.4.3.

## [3.4.2] - 2026-04-17

### Fixed
- **Agenda step request cut off at ~2000 characters in the Output tab** — both the success and failure write paths in `bridge-logger.mjs` sliced `rendered_prompt` to 2000 chars before persisting it into `agenda_run_steps.input_payload`. For long free-form prompts (multi-section instructions, guide references, bilingual captions, etc.) the detail sheet displayed a truncated copy even though `agenda_occurrences.rendered_prompt` held the full text. The slice is removed on both paths; the full prompt is now stored and rendered verbatim.

### Changed
- **Prompt template v2.2 — artifact-directory rules tightened.** The output-rules block in `prompt-renderer.mjs` now explicitly requires the agent to save, inside the occurrence's artifact directory: all output files it creates, and all downloaded or reference files it pulls in (assets, guides, examples, images, PDFs — anything fetched, downloaded, or copied from another location). Creating, downloading, or saving files anywhere else in the workspace is forbidden. Existing events keep their persisted `rendered_prompt`; only new cron runs and manual retries pick up the new template.
- **Deterministic agent-output capture via `response.md` contract.** The output-rules block also instructs the agent to write its final written response to `{artifactDir}/response.md`. `bridge-logger.mjs` now reads that file first in `resolveAgendaOutput` (with a 1.5s grace retry) and uses it as the authoritative output (`outputSource: 'response_file'`) when present. This sidesteps session-transcript scraping, AGENDA_MARKER scans, prompt-echo heuristics, and 3/5/7s retry-with-backoff for every run that honours the contract. The existing session-scrape path stays in place as a fallback for older runs and agents that skip the contract.
- **Version bump** to 3.4.2.

## [3.4.0] - 2026-04-14

### Fixed
- **Gateway RPC fails after openclaw update** — `gateway-rpc.mjs` hardcoded a content-hashed chunk filename (`call-Iw4xDZUX.js`) that changes on every openclaw release. Script now dynamically discovers the `call-*.js` chunk in `/usr/lib/node_modules/openclaw/dist/` at runtime so agenda event creation survives openclaw updates without manual intervention.
- **Production build: `Cannot find module 'typescript'`** — TypeScript was in `devDependencies` but `next build` under `NODE_ENV=production` skips devDeps. Converted `next.config.ts` → `next.config.mjs` to remove the TypeScript transpilation requirement entirely.
- **Production build: `Cannot find module 'postgres'`** — duplicate `postgres` entry in both `dependencies` and `devDependencies` removed; added `serverExternalPackages: ["postgres"]` to `next.config.mjs` so Turbopack treats it as a Node.js runtime module instead of bundling it.
- **Production build: `Cannot find module '@tailwindcss/postcss'`** — `@tailwindcss/postcss`, `tailwindcss`, and `tw-animate-css` moved from `devDependencies` to `dependencies` (all three are consumed by the CSS build pipeline, not just type-checking).
- **Production build: `Can't resolve 'shadcn/tailwind.css'`** — removed `@import "shadcn/tailwind.css"` from `globals.css`; `shadcn` is a CLI scaffolding tool whose CSS export duplicated variables already defined inline.
- **Update script blocked by local changes** — `scripts/update.sh` now stashes any dirty working tree before `git pull --ff-only`, then pops the stash afterwards. On stash-pop conflict the upstream version wins and the stash is dropped cleanly.
- **Folder "Date modified" shows creation time instead of latest change** — folders in the file manager now display the newest `mtime` found anywhere in their subtree (up to depth 6, 800 entries), matching Windows Explorer behaviour where a folder's modified date reflects the most-recently-changed nested file.

### Added
- **File manager — zip upload modal** — uploading a `.zip` file now shows a choice dialog: *Upload as zip* (stores the archive as-is) or *Extract here* (unzips contents directly into the current folder using `adm-zip` with path-traversal protection). Multiple zips in a single drop are handled together. Non-zip files in the same batch upload immediately without interruption.
- **File manager — forward navigation** — back `←` and forward `→` history buttons with a full `navHistory` stack. Backspace still navigates to the parent folder.
- **File manager — arrow key navigation** — `↑`/`↓` moves a focus ring through the file list; `Enter` opens the focused item; auto-scrolls into view.
- **File manager — sort persistence** — sort field and direction saved to `localStorage`; survive page reload and folder navigation.
- **File manager — intra-app drag-and-drop** — drag any file or folder onto another folder row/card to move it; dragging selected items moves all of them; drop target highlighted; conflict dialog fires if needed.
- **File manager — F2 / Ctrl+C / Ctrl+V shortcuts** — F2 renames the hovered or focused item; Ctrl+C copies hovered/selected items to an in-memory clipboard; Ctrl+V opens the Move/Copy dialog pre-loaded with clipboard contents.
- **File manager — global search location in grid view** — search results in grid mode show a clickable parent-path badge under each item name, matching the existing list-view behaviour.

### Changed
- **Repository URL** updated from `kenandevx/mission-control` to `openclaw-milolabs/mission-control` in `README.md` and `scripts/install.sh`.
- **Version bump** to 3.4.0.

## [3.3.0] - 2026-04-09

### Fixed
- **Watchdog bash CPU spin (16.7% CPU → 0.0%)** — `start_watchdog` in `mc-services.sh` serialized function definitions via `declare -f` but not the variables they reference (`WATCHDOG_INTERVAL`, `SERVICES`, `SERVICE_CMDS`, etc.). The spawned bash subprocess had empty variables, so `sleep "$WATCHDOG_INTERVAL"` became `sleep ""` → instant failure → tight infinite loop consuming 16.7% CPU. Fixed by adding `declare -p` for all required variables alongside `declare -f`.
- **`cache.ts` CLI subprocess CPU spikes (~30% per page load → negligible)** — `lib/runtime/cache.ts` spawned `openclaw agents list --json` and `openclaw sessions --all-agents --json` as child processes with a 30s TTL cache. Each CLI invocation took ~10 seconds of CPU time (Node.js cold boot + gateway WS handshake). Every `/agents` or `/agenda` page load that missed the cache triggered this. Rewritten to read directly from local files (`openclaw.json`, `IDENTITY.md`, `sessions.json`) — response time dropped from ~10s to 22ms.
- **Agenda-scheduler orphan sweep CPU spikes** — `getLiveCronJobIds()` called `openclaw cron list --json` on every 15-second tick. Each invocation took ~10s of CPU. Throttled to run every 5 minutes instead (configurable via `AGENDA_ORPHAN_SWEEP_MS` env var, default 300000ms). On failure, the sweep timestamp is still recorded to avoid hammering a broken endpoint.

### Changed
- **Agent discovery** now reads from local OpenClaw files instead of CLI subprocesses: agent list from `openclaw.json`, identity names from workspace `IDENTITY.md` files, session activity from `sessions.json` per agent.
- **New env var**: `AGENDA_ORPHAN_SWEEP_MS` — controls how often the scheduler runs orphan detection (default: 5 minutes).
- **Version bump** to 3.3.0.

### Performance
- Total Mission Control CPU at steady state: **~30% → ~3.5%**
  - Watchdog: 16.7% → 0.0%
  - Agenda-scheduler: ~15% (oscillating) → 0.2%
  - Bridge-logger: 0.1% (unchanged)
  - Next.js: 0.5–1% (unchanged)
  - `/api/agents` response time: ~10s → 22ms

## [3.2.0] - 2026-04-07

### Fixed
- **Sidebar Live Activity click re-opened ticket modal on refresh** — clicking a ticket entry in the Live Activity sidebar was navigating to `/boards?ticket=<id>`, which a `useEffect` in `boards-page-client` read on mount to auto-reopen the modal. Clicking now dispatches a `mc:open-ticket` custom DOM event instead — the board page listens for it and opens the modal directly with no URL modification. Refreshing the page is completely clean.
- **`BoardActivityFeed` click was also writing `?ticket=` to the URL** — removed; clicking a ticket in the board's in-page activity feed no longer touches the URL.
- **Notification API was building `targetUrl` with `?ticket=<id>`** — both `/api/notifications/recent` and `/api/notifications/stream` now include `board_id` in the ticket activity query and build `targetUrl` as `/boards?board=<boardId>` only. The `ticketId` and `boardId` are exposed as separate typed fields on the `ActivityEntry` so the sidebar can route correctly without encoding ticket IDs into the URL.
- **Kanban: `updateTicket` was destroying execution state on every save** — the `updateTicket` API action hard-reset `execution_state`, `assigned_agent_id`, `execution_mode`, `plan_text`, `plan_approved`, `execution_window_minutes`, and `fallback_model` to defaults on every ticket save, regardless of which fields actually changed. Only explicitly passed fields are now updated; all other fields are preserved.
- **Kanban: ticket `updateTicket` missing `ticket_activity` audit row** — saving a ticket via the details modal now correctly writes a per-ticket activity log entry. `logTaskAudit` previously dropped `ticketId`, so the activity tab never reflected ticket edits.
- **Kanban: `moveTicket` activity log had no column names and no ticket_activity row** — the audit trail now shows `"Moved from {From List} to {To List}"` instead of the generic `"Moved to a new column."`, and `ticketId` is correctly passed so the entry appears on the ticket's activity tab.
- **Kanban: `updateColumn` had no audit trail or SSE notification** — renaming a list now logs to `activity_logs` and emits a `pg_notify('ticket_activity', ...)` event so live-connected clients can react.
- **Kanban: `createColumn` had no SSE notification** — creating a new list now emits `pg_notify('ticket_activity', 'column:created:<id>')` immediately after creation.
- **`createTicket` INSERT referenced non-existent `process_version_ids` column** — removed from the INSERT statement. Also corrected `execution_mode` default from `'direct'` to `'auto'` to match the DB schema default.
- **`toIsoDueDate` could produce malformed ISO strings** — if `scheduledFor` or `dueDate` already contained a `T` (already in ISO format), appending `T00:00:00.000Z` produced an invalid double-T date string. Fixed by detecting existing ISO strings and returning them as-is.
- **Due date input showed time component** — the date input in the ticket modal now strips to `YYYY-MM-DD` only via `.slice(0, 10)` to prevent time leakage into the field value.

### Changed
- **Kanban Integration Test panel removed** — `kanban-test-panel.tsx`, `kanban-test-definitions.ts`, and `use-kanban-tests.tsx` deleted; import and render removed from `boards-page-client.tsx`.
- **Ticket card redesigned**:
  - Left accent border colored by priority (emerald / amber / orange / rose).
  - Priority shown as a compact dot + uppercase label instead of a full outline badge.
  - Tags are pill-shaped (`rounded-full`).
  - Attachment count icon added to footer meta row.
  - Checklist done count turns emerald green when fully complete.
  - Drag ghost uses `rotate-1` + heavier shadow for clearer spatial feedback.
- **Ticket details modal improved**:
  - Checklist progress bar added to the right sidebar (visible when ticket has subtasks).
  - Priority dropdown shows colored dots alongside option labels.
  - Sidebar spacing tightened; separator between progress and fields.
- **README**: version bumped to 3.2.0.

## [3.0.0] - 2026-04-05

### Fixed
- **Agenda event card shows wrong status** (`needs_retry` even after a newer occurrence succeeded): `DISTINCT ON` query used status-priority as the primary sort key, so `needs_retry` (rank 2) always beat `succeeded` (rank 4) regardless of which occurrence was newer. Fixed by sorting `scheduled_for DESC` first and using status priority only as a tiebreaker within the same time slot.
- **Isolated run output always empty**: `resolveAgendaOutput` was calling `looksLikePromptEcho(sessionOutput, null, summaryText)` where `summaryText` for isolated runs **is** the agent's actual output — comparing the output against itself always returned a false-positive match and wiped the result to an empty string. Fixed by using `summaryText` directly as the canonical output for isolated sessions, skipping the misleading echo detection.
- **Isolated run with no output incorrectly marked succeeded**: when `run.summary` was empty, `outputSource` stayed as `cron_summary` instead of `no_output`, causing the run to count as a success with no content. Fixed by explicitly setting `outputSource = 'no_output'` when isolated summary is blank.
- **SSE stream sends stale status**: the stream handler re-queried `ao.status` from the DB after receiving a `pg_notify`, but the DB update may not have committed yet, causing the sidebar to briefly show the previous status (e.g. `running` after `succeeded`). Fixed by using the `action` field from the notification payload as the authoritative status; DB query now only fetches title and agent.
- **Live Activity shows `needs_retry` after succeeded**: same race — SSE sent a stale `needs_retry` for an occurrence that had just been marked `succeeded`. Resolved by the SSE action-based fix above.
- **Recent activity API returned future scheduled occurrences instead of past runs**: `ORDER BY scheduled_for DESC` sorted future-dated recurring occurrences (e.g. April 19) to the top, burying today's runs. Fixed with `COALESCE(last_run_at, scheduled_for) ASC` using a `LATERAL` subquery for the most recent attempt timestamp.
- **Recent activity API pulled from `agenda_run_attempts`** (only `running`/`succeeded`/`failed`) instead of `agenda_occurrences` (full canonical status set including `needs_retry`, `queued`, `auto_retry`, etc.). Sidebar now always shows canonical occurrence statuses.
- **SSE stream used `action` from pg_notify as event name but DB status for display**: now uses occurrence status for both since SSE action is the canonical source of truth.

### Changed
- **Live Activity sidebar — full overhaul**:
  - Status dot colors use exact hex values from `lib/status-colors.ts` for all agenda entries (no more generic Tailwind classes).
  - `running` and `auto_retry` dots pulse with `animate-pulse`.
  - Event labels for all canonical agenda statuses route through `statusLabel()` — single source of truth.
  - Agent field shows human-readable name (`Main agent`, `Worker`, etc.) instead of raw ID strings.
  - Title attribute on each row shows `title — status` for accessibility.
  - "just now" threshold widened from 10 s to 30 s (avoids flickering on initial page load).
  - Empty state uses italic muted text instead of a bold placeholder.
  - Connecting indicator shows "Connecting…" instead of "…".
  - Removed unused `LEVEL_CONFIG` icon imports and `Icon` references from render.
  - `dotStyle` and `labelColor` helper functions centralize all color derivation.
- **Agenda event sort order** (`/api/agenda/events`): both calendar-range and list queries now sort `scheduled_for DESC` before status priority, ensuring newest occurrence always wins.
- **Bridge-logger isolated output**: simplified to use `run.summary` directly — no session file read, no false-positive echo detection for isolated sessions.
- **`levelFromAction` in stream route**: added `queued`, `scheduled`, `cancelled`, `skipped` → `info` mappings.
- **`agendaLevelFromStatus` in recent route**: added `stale_recovery`, `force_retry`, `queued`, `scheduled`, `cancelled`, `skipped`, `draft` mappings.
- **README**: version bumped to 3.0.0, Next.js noted as v16, Live Activity Sidebar section added under Artifact Files.

## [2.8.3] - 2026-04-05

### Changed
- **Status colors darkened**: Tweaked all status hex values to be more vibrant and less pastel, still maintaining the same color identity. New values are darker for better contrast on dark backgrounds.

## [2.8.2] - 2026-04-05

### Refactor
- **Shared status colors**: All status hex values now live in a single source of truth (`STATUS_HEX` in `lib/status-colors.ts`). Six component files refactored to import from this shared module instead of hardcoding colors.
- Updated color palette to the design-specified hex values:
  - Scheduled `#A8DADC` · Queued `#CDB4DB` · Running `#F4A261`
  - Auto-retry `#FFAFCC` · Stale Recovery `#FFB4A2` · Succeeded `#2E7D32`
  - Needs Retry `#FFD166` · Failed `#E63946` · Cancelled `#D3D3D3`
  - Skipped `#EAD7A1` · Draft `#C9D6DF`
- Helper functions `statusHex()`, `statusBg()`, `statusText()` for consumers that need exact hex.
- `STATUS_GUIDE_ENTRIES`, `STATUS_BADGE_MAP`, `STATUS_META` now auto-derived from the single hex map — zero duplication.
- Dot/status indicators, badges, running/spinner, needs-retry, and status guide cards all use exact shared hex values.

### Fixed
- Details-sheet event log "Running" title was still blue — now `#F4A261`.
- Active events with no `latestResult` displayed as grey (indigo fallback) — now correctly show as cyan `#A8DADC` (scheduled).
- `custom-month-agenda.tsx` — 167 lines cleaned: removed `RESULT_INDICATOR` and `STATUS_LABEL_COLORS` maps; everything now sourced from `STATUS_HEX`.
- `agenda-stats-cards.tsx` — running card ring/badge updated to `#F4A261` instead of indigo.
- `agenda-failed-bucket.tsx` — failed/needs_retry badge colors from shared hex.
- `agenda-test-panel.tsx` — test status badges/icons from shared hex.

## [2.8.1] - 2026-04-04

### Changed
- **README**: Complete rewrite — all features, full architecture diagrams, comprehensive API reference, complete DB schema, scripts reference, troubleshooting table, environment variables guide, services overview, log pipeline flow diagrams, Kanban data model, process simulation details, agenda scheduler/bridge-logger deep-dives. Now the single source of truth for developers and AI agents alike.

## [2.8.0] - 2026-04-04

### Fixed
- **Status colors**: `queued` events now display grey (waiting) instead of blue. Blue is reserved exclusively for actively `running` events. Previously, events waiting in the cron queue appeared blue, causing confusion with actively executing events.

### Added
- **Event detail modal**: Added "Created At" card showing when the event was first created
- **Event detail modal**: Added "Model" card showing the model override or "Agent default"
- **Event detail modal**: Added dedicated "Status" card showing current occurrence status prominently
- **Status Guide popup**: Added missing status entries: `auto_retry`, `force_retry`, `stale_recovery`
- **Status Guide popup**: Redesigned with lifecycle grouping, colored dots, and richer descriptions

### Changed
- **README**: Complete rewrite — agent-friendly file map, corrected color guide, flowcharts, API reference
- **Status Guide**: Updated `queued` description to clarify it means "cron assigned, waiting to fire" (grey, not blue)

## [2.7.0] - 2026-04-03

### Fixed
- Calendar event colors: `run_started_at`/`run_finished_at` now included in all event queries
- Cron job creation: Scheduler now uses `--at 30s` for past timestamps instead of failing

### Added
- Artifact files: Download and inline preview in Output tab
- Process simulation: Dry-run mode with SSE streaming

### Changed
- Execution engine: Migrated from BullMQ/Redis to OpenClaw native cron engine
- No Redis dependency
