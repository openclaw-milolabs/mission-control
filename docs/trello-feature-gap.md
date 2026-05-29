# Kanban — Trello feature-gap research

Snapshot of what Trello / Atlassian Jira-Trello provide on a board today vs. what Mission Control's Kanban surface currently has, with a prioritised plan for what to close.

This is a discussion doc, not a spec. Each recommended item still needs its own brainstorm + plan before code.

> Status legend: ✅ have it · 🟡 partial · ❌ missing · ⛔ intentionally out of scope

---

## What Trello has on a board

### Board-level
| Feature | MC status | Notes |
|---|---|---|
| Multiple boards per workspace | ✅ | `boards` table, board switcher |
| Board templates | ❌ | No "create from template" flow; user clones boards manually |
| Board background / cover image | ❌ | Boards are visually identical aside from column colors |
| Board favorites / pinning | ❌ | No personal favourites; everyone sees the same order |
| Board starring per user | ❌ | Same |
| Board archive (vs. delete) | ❌ | Only hard delete with cascade |
| Board sharing / member roles (admin / member / observer) | 🟡 | Workspace-level auth only; no per-board roles |
| Power-ups / integrations | ⛔ | Out of scope for now |
| Board activity feed | ✅ | Live SSE feed in the right sidebar |
| Board calendar view | ❌ | Only kanban / list / grid; no calendar surface for tickets with `due_date` |
| Board map view | ⛔ | Out of scope |
| Board timeline / Gantt | ❌ | No dependency or timeline visualisation |
| Board export (CSV / JSON) | ❌ | No export entrypoint |
| Board copy | ✅ | "Copy board" duplicates lists + tickets |

### List (column) level
| Feature | MC status | Notes |
|---|---|---|
| Create / rename / colour list | ✅ | |
| Reorder lists | ✅ | dnd-kit drag |
| Archive list | ❌ | Hard delete only |
| Watch list (subscribe) | ❌ | No per-user watch state |
| Move all cards in list | ❌ | No bulk-move affordance |
| Sort list (manual / by due / by priority) | 🟡 | Whole-board sort exists (`sort` state in useTasks), no per-list sort |
| WIP limits per list | ❌ | No limit / no warning indicator |

### Card (ticket) level
| Feature | MC status | Notes |
|---|---|---|
| Title, description, due date | ✅ | |
| Markdown description | 🟡 | Description is plain text; activity feed has markdown but ticket description doesn't |
| Cover image / colour | ❌ | No card cover; only priority dot |
| Labels with name + colour | 🟡 | Tags are strings without per-board colour palette |
| Checklists (multiple per card) | ✅ | `ticket_subtasks` with `checklist_name` |
| Checklist item assignee + due date | ❌ | Items only have title + completed |
| Attachments | ✅ | `ticket_attachments`, inline + file-path |
| Comments | ✅ | `ticket_comments` |
| @mention members | ❌ | **Item #6 in the next sprint** |
| Custom fields | ❌ | No structured extra fields beyond schema |
| Card members (assignees) | ✅ | Now per-board custom assignees + multi-select picker in modal |
| Card stickers / emoji | ⛔ | Out of scope |
| Card votes | ⛔ | Out of scope |
| Card watch / subscribe per user | ❌ | No watcher state, no per-user-following |
| Activity per card | ✅ | `ticket_activity` table, modal activity tab |
| Move card between boards | ❌ | Move is restricted to same-board column moves |
| Copy card | ✅ | `handleCopyTicket` |
| Convert card to template | ❌ | |
| Card archive | ❌ | Only delete |
| Card link copy / shortlink | 🟡 | Custom event flow opens by ticket id; no copyable URL |

### User-level / cross-cutting
| Feature | MC status | Notes |
|---|---|---|
| @mention notifications + bell | ❌ | **Item #6** |
| Inbox / mentions inbox | ❌ | Same |
| Email digest for mentions | ❌ | Same; would reuse `notification_channels` |
| Filter by member | ✅ | **Item #7 — just shipped** |
| Filter by label / tag | ❌ | Tag-search exists via free-text search, no dedicated filter chip |
| Filter by due date / overdue | ❌ | Sort by due exists; filter does not |
| Quick add card (from anywhere) | ❌ | Must navigate to a board first |
| Keyboard shortcuts (`?` menu, `n` to add card, etc.) | ❌ | None |
| Per-column pagination / virtualization | ✅ | **Item #8 — just shipped (Show more after 25)** |
| Saved filters / per-user views | ❌ | All filter state is in-memory |
| Multi-board search | ❌ | Search is scoped to the active board |
| Drag-to-board navigation | ❌ | No drag from sidebar to a board |

---

## Gaps that hurt today

Ranked by user-pain × effort. Top entries are the high-value next moves.

### Tier 1 — quick wins (small effort, immediate pain relief)

1. **Per-board labels with colour palette** (vs. free-text tags). Same model as `board_assignees`: a `board_labels` table, ticket `label_ids text[]`. The current tags are easy to typo, untyped, and have no visual differentiation. Effort: ~1 session.
2. **Filter by label / due-date** (overdue / due this week / no due date). Reuses the same toolbar pattern as the assignee filter we just shipped. Effort: ~half session.
3. **Calendar view of tickets with due dates**. New view alongside kanban/list/grid. Effort: ~1 session.
4. **Per-card shareable URL** (`/boards?board=<id>&ticket=<id>`). Already implementable via existing routing; just needs a "Copy link" affordance on the ticket modal. Effort: ~half session.

### Tier 2 — high value, real work

5. **Archive vs. delete** for boards, lists, tickets. Soft-delete column on each table; queries default to non-archived; a "Show archived" toggle. Reduces accidental data loss. Effort: ~1-2 sessions including migration + UI.
6. **Card watchers + activity subscriptions**. `ticket_watchers` table (`ticket_id`, `user_sub`). Mention/comment/move events on watched tickets fan out into the same notification model as @mentions. Pairs naturally with item #6.
7. **Bulk actions on selected tickets** (multi-select → move / archive / change priority / add label). Effort: ~1-2 sessions; needs selection state and a contextual action bar.
8. **WIP limits per list** + visual warning when exceeded. Schema change on `columns` (`wip_limit int`). Subtle red counter in the column header. Effort: ~half session.
9. **Markdown description rendering** for tickets. Already have an activity markdown renderer; reuse it. Effort: ~half session.

### Tier 3 — bigger features (own sessions each)

10. **Board templates** + "Create board from template" flow.
11. **Per-board roles** (admin/member/observer) gated by Azure AD groups.
12. **Saved filter views** persisted per user (`board_views` table).
13. **Quick-add modal** triggered from anywhere (keyboard shortcut `c`).
14. **Keyboard shortcut layer** + `?` overlay.
15. **Timeline / Gantt view** for tickets with start + due dates.

### Tier 4 — backlog / nice-to-have

- Stickers, emoji reactions on comments, card votes, card stamps, butler-style rules.
- Power-up framework / external integrations (Slack, Drive, Zapier-like rules).
- Mobile-specific layouts beyond the current responsive drop.

### Out of scope

- ⛔ Map view, in-card video (Trello's Atlassian-only features).
- ⛔ Multi-tenant external sharing (this is an internal tool).

---

## Recommended next-three after the current sprint

When `#6` (mentions + bell) wraps, the highest-leverage next moves are:

1. **Per-board labels with colour** (Tier 1.1) — same shape as `board_assignees`, lifts tag UX dramatically.
2. **Archive vs. delete** (Tier 2.5) — stops accidental data loss across the model, very high "I'm glad we have this" value.
3. **Card watchers** (Tier 2.6) — once notifications exist for @mentions, this is one extra column on a join table and the same delivery code.

After those three, reconvene to choose between calendar view, bulk actions, and WIP limits depending on which pain is loudest at that point.

---

## What we just shipped (this sprint)

- ✅ #4 — Logged-in user's name attributed to every activity row + comment author
- ✅ #7 — Filter tickets by assignee
- ✅ #8 — Per-list cap with "Show more" (default page size 25)
- 🟡 #6 — Plan exists, implementation pending
- 🟡 #1–3 — Design overhauls deferred until PRODUCT.md / DESIGN.md are seeded for `impeccable`
