# Mobile Applications module — design

> **⚠️ SUPERSEDED (2026-06-08):** This historical design used `google-play-scraper` and the Apple customer-reviews RSS feed. The shipped module now uses the **official store APIs only** (Google Play Android Publisher API + Apple App Store Connect API), is **view-only**, loads credentials from `secrets.env`, paginates the reviews feed, and **no longer includes threshold alerts**. The data-source rows below are kept only as a record of the initial approach and do not reflect the current code.

**Date:** 2026-06-05
**Status:** Approved design, ready for implementation planning
**Module key:** `mobile-apps` · **Route:** `/mobile-apps` · **Nav label:** "Mobile Applications"

## Summary

A new toggleable Mission Control module that fetches **App Store + Google Play reviews and
ratings for our own apps**, stores history, and surfaces them in a dashboard with
ratings-over-time charts, a filterable reviews feed, agent-written sentiment digests, and
threshold alerts.

Data is fetched **in real time on page load** (no background poller, no managed service).
v1 uses **free public sources** behind a thin provider interface so official APIs (for replies
and full history) can be swapped in later without touching consumers.

The name is intentionally generic ("Mobile Applications", not "App Reviews") so future
capabilities — ASO/rank tracking, crash stats, release tracking, reply-to-reviews — live under
the same module.

## Decisions (locked)

| Question | Decision |
|---|---|
| App scope | **Our own apps only** |
| Stores at launch | **Both Apple + Google** |
| Data source | **Free public sources** (Apple RSS + iTunes Lookup; Play scraping), behind a provider interface for later official-API swap |
| Module job (v1) | **Agent sentiment summaries** + **ratings tracking & threshold alerts**. No auto-tickets, no replies. |
| Placement | **New standalone module** named "Mobile Applications" |
| Sync cadence | **Real-time on page load** + manual "Refresh now". No 6h background poller, no new service. |
| App ↔ store modeling | **One logical app spans both stores** (Apple + Google listings under one app) |
| Alerts firing | Evaluated **at the end of each on-load sync** (only while someone views the page in v1). Scheduled firing is a follow-up. |
| Digests | **On-demand only** ("Generate digest now"); no automatic cadence (avoids token spend per page view) |

## Data sources (v1, free/public)

- **Apple reviews** — RSS customer-reviews JSON:
  `https://itunes.apple.com/{country}/rss/customerreviews/id={appId}/sortBy=mostRecent/json`.
  No auth. Limited to ~last 500 reviews per country, recent pages only.
- **Apple rating summary + metadata** — iTunes Lookup: `https://itunes.apple.com/lookup?id={appId}`.
  Star average, ratings count, version, icon. Plain `fetch`, no dependency.
- **Google Play reviews + rating histogram** — `google-play-scraper` npm package (unofficial).
  ToS gray area and can break on Google HTML changes — isolated behind the provider so failures
  degrade gracefully (show cached + a "Play sync failed" notice) rather than break the page.

Known limits are acceptable for read-only v1. Official App Store Connect + Play Developer APIs
are a future upgrade behind the same provider interface (needed for replies and full history).

## Architecture

### Provider interface
A `ReviewProvider` abstraction with two methods:
- `fetchReviews(listing): Review[]`
- `fetchRatingSummary(listing): { avgRating, ratingsCount, histogram }`

Implementations: `AppleProvider`, `GoogleProvider`. New stores or the official-API upgrade are
new implementations only.

### Ingestion (real-time, no background service)
- Entering `/mobile-apps` or an app detail triggers `POST /api/mobile-apps/sync`, which calls the
  relevant providers, **upserts** reviews (dedup on `store_review_id`), and writes a fresh
  `app_rating_snapshots` row per listing.
- **"Refresh now"** button forces a re-sync.
- **Stale-while-revalidate UX**: page renders DB-cached rows immediately; the live sync runs; new
  results stream in via SSE (`pg_notify('mobile_apps_change')`). First-ever load (no cache) shows a
  loading state.
- **De-dupe guard**: skip re-hitting a store if it synced within a short window (default ~60s,
  configurable) to avoid throttling/blocks from rapid refreshes or multiple open tabs. "Refresh
  now" can override.

### Agent sentiment digest
Reuses the **gateway-rpc agent dispatch** the agenda scheduler already uses. Triggered on demand
("Generate digest now"). Composes a prompt from new reviews since the last digest; the agent returns
a summary, sentiment trend, top complaints/praise, and themes. Saved to `app_review_digests` and
shown on the page. May optionally back-fill each review's `sentiment` / `themes`.

### Alerts
After each on-load sync, evaluate `app_alert_rules` against the latest snapshot/reviews. On a trip,
fan out through the existing `notification_channels` (Telegram/Slack) and stamp `last_fired_at`.
Same pattern as agenda failure alerts. Suggested default rules: *avg rating below 4.0* and
*1-star spike*.

## Data model (new tables)

- **`mobile_apps`** — `id`, `workspace_id`, `name`, `icon_url`, `notes`.
- **`mobile_app_listings`** — `id`, `mobile_app_id`, `store` (`apple`|`google`), `store_app_id`,
  `country`, `current_rating`, `ratings_count`, `last_synced_at`.
- **`app_reviews`** — `id`, `listing_id`, `store_review_id` (unique per listing → dedup), `author`,
  `rating` (1–5), `title`, `body`, `app_version`, `country`, `submitted_at`, `store_response`
  (existing developer reply if present), `sentiment` (nullable, agent-filled),
  `themes text[]` (nullable), `fetched_at`.
- **`app_rating_snapshots`** — `id`, `listing_id`, `captured_at`, `avg_rating`, `ratings_count`,
  `histogram jsonb` (1–5 star counts). Powers trend charts.
- **`app_review_digests`** — `id`, `mobile_app_id`, `period_start`, `period_end`, `summary_md`,
  `sentiment_score`, `top_themes jsonb`, `generated_by_agent_id`, `created_at`.
- **`app_alert_rules`** — `id`, `mobile_app_id` (null = all apps), `metric`
  (`avg_rating`|`one_star_spike`|`review_volume`), `operator`, `threshold`, `window`, `channel_ids`,
  `enabled`, `last_fired_at`.

## API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/mobile-apps` | GET | List tracked apps + listings + latest rating |
| `/api/mobile-apps` | POST | Add app (resolve from App Store / Play URL or ID) |
| `/api/mobile-apps/[id]` | GET | App detail: listings, reviews (paged/filtered), snapshots |
| `/api/mobile-apps/[id]` | DELETE | Remove tracked app |
| `/api/mobile-apps/sync` | POST | Live sync (all or one app); upsert reviews + snapshot; evaluate alerts |
| `/api/mobile-apps/[id]/digest` | POST | Generate agent sentiment digest now |
| `/api/mobile-apps/[id]/digest` | GET | Digest history |
| `/api/mobile-apps/alerts` | GET/POST/PATCH/DELETE | Alert-rule CRUD |
| `/api/mobile-apps/stream` | GET | SSE: live sync/review updates |

## UI — `/mobile-apps`

- **App grid**: card per app — icon, name, both store badges (★ rating + count), 7-day delta
  sparkline.
- **Add app**: paste an App Store URL and/or Play URL (or IDs) → resolves name + icon.
- **App detail**:
  - **Ratings-over-time chart** — reuse Metrics' recharts components + daily/weekly/monthly window
    switcher; toggle Apple / Google / combined. Star **histogram**.
  - **Reviews feed** — filter by store / rating / country / sentiment / has-reply; search; sort by
    recent or rating. Each card: stars, author, app version, country, body, developer response (if
    any), agent sentiment tag.
  - **Digest panel** — latest markdown + history, with "Generate digest now."
  - **Alerts** — config panel for `app_alert_rules`.
- Live updates via SSE, consistent with the rest of Mission Control.

## Settings

- Module toggle in **Settings → Modules** (impact-preview disable + typed confirmation, like
  Documents/Metrics).
- Sync de-dupe window (default ~60s).
- Default alert thresholds.

## Dependencies

- Add `google-play-scraper`. Apple uses plain `fetch` (no dependency).

## Out of scope for v1 (clean follow-ups behind the same provider interface)

- Replying to reviews (needs official App Store Connect + Play Developer APIs).
- Full historical review backfill.
- **Scheduled alert checks** that fire without someone viewing the page (could reuse the agenda
  engine).
- Automatic digest cadence.
- ASO keyword / rank tracking, top-chart position, crash/ANR stats, competitor benchmarking.
