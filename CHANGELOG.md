# Changelog

All notable changes to Mission Control are documented here.


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
