# Mobile Applications Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable "Mobile Applications" module that fetches App Store + Google Play reviews and ratings for our own apps in real time on page load, stores history, and surfaces them with ratings charts, a filterable reviews feed, on-demand agent sentiment digests, and threshold alerts.

**Architecture:** Follows Mission Control's existing module pattern (declarative `registry.ts` entry + `lib/modules/handlers/<id>.ts` for setup/preview/cleanup + server-side `requireModuleEnabled` gates + client `useModules().isEnabled` nav gating). Review fetching sits behind a `ReviewProvider` interface with `AppleProvider` (RSS + iTunes Lookup, plain `fetch`) and `GoogleProvider` (`google-play-scraper`). A single `POST /api/mobile-apps/sync` endpoint does live fetch → upsert → snapshot → `pg_notify`. The UI uses stale-while-revalidate: render DB-cached rows, trigger sync, stream results via SSE. Agent digests reuse the synchronous `openclaw agent --json --local` dispatch primitive (same as `app/api/processes/simulate/route.ts`). Alerts fan out through the existing `notification_channels` table.

**Tech Stack:** Next.js 16 App Router (TypeScript), `postgres` (`getSql` from `@/lib/local-db`), `google-play-scraper`, recharts (reuse `components/metrics/metric-chart.tsx`), `@tabler/icons-react`, SSE via PostgreSQL LISTEN/NOTIFY. Tests: `node:assert` scripts under `scripts/` (project convention — no jest/vitest), plus `npx tsc --noEmit`, `npm run lint`, `npm run build`.

---

## Conventions used throughout this plan

- **Server module gate** (copy this in every `/api/mobile-apps/**` route): after auth, call `if (!(await isModuleEnabled("mobile-apps"))) return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);`
- **Response helpers** (already used across routes):
  ```ts
  const ok = (data = {}) => NextResponse.json({ ok: true, ...data });
  const fail = (message: string, status = 400) => NextResponse.json({ ok: false, error: message }, { status });
  ```
- **Workspace id**: `select id from workspaces order by created_at asc limit 1`.
- **Typecheck command** (used as the "test" for type-level tasks): `npx tsc --noEmit`. Expected: no errors.
- **Pure-logic tests** live in `scripts/mobile-apps/*.test.mjs` and run with `node scripts/mobile-apps/<name>.test.mjs`. They use `node:assert/strict` and print `ok - <name>` lines; a throw = failure.

---

## File Structure

**Create:**
- `lib/modules/handlers/mobile-apps.ts` — module setup/preview/cleanup (creates/drops the 6 tables).
- `lib/mobile-apps/types.ts` — shared TS types (`Store`, `RawReview`, `RatingSummary`, `ReviewProvider`, row types).
- `lib/mobile-apps/providers/apple.ts` — Apple RSS + iTunes Lookup provider + pure parsers.
- `lib/mobile-apps/providers/google.ts` — Google Play provider (`google-play-scraper`) + pure mappers.
- `lib/mobile-apps/providers/index.ts` — `getProvider(store)` factory.
- `lib/mobile-apps/resolve.ts` — pure: extract `{ store, storeAppId, country }` from a pasted App Store / Play URL or raw ID.
- `lib/mobile-apps/sync.ts` — server: sync one app (call providers, upsert reviews, write snapshot, return counts). Shared by the sync route.
- `lib/mobile-apps/alerts.ts` — pure rule evaluation + server fan-out via `notification_channels`.
- `lib/mobile-apps/digest.ts` — server: build the digest prompt + dispatch agent + parse output.
- `app/api/mobile-apps/route.ts` — GET (list apps) / POST (add app) / DELETE (remove app).
- `app/api/mobile-apps/[id]/route.ts` — GET app detail (listings, reviews paged/filtered, snapshots).
- `app/api/mobile-apps/sync/route.ts` — POST live sync (all or one app).
- `app/api/mobile-apps/[id]/digest/route.ts` — POST generate digest / GET digest history.
- `app/api/mobile-apps/alerts/route.ts` — GET/POST/PATCH/DELETE alert-rule CRUD.
- `app/api/mobile-apps/stream/route.ts` — SSE: live `mobile_apps_change`.
- `app/mobile-apps/page.tsx` — server page shell (sidebar + client).
- `app/mobile-apps/[id]/page.tsx` — server page shell for app detail.
- `components/mobile-apps/mobile-apps-client.tsx` — app grid + add-app dialog.
- `components/mobile-apps/app-card.tsx` — one app card (icon, store badges, sparkline).
- `components/mobile-apps/app-detail-client.tsx` — detail page (ratings chart, histogram, reviews feed, digest, alerts).
- `components/mobile-apps/review-card.tsx` — one review row.
- `components/mobile-apps/add-app-dialog.tsx` — paste URL/ID dialog.
- `scripts/mobile-apps/resolve.test.mjs`, `scripts/mobile-apps/apple-parse.test.mjs`, `scripts/mobile-apps/google-map.test.mjs`, `scripts/mobile-apps/alerts.test.mjs` — pure-logic tests.

**Modify:**
- `lib/modules/registry.ts` — add `"mobile-apps"` to `ModuleId` union + a `MODULES` entry.
- `app/api/modules/route.ts` — register `mobileAppsHandler` in `HANDLERS`.
- `components/layout/app-sidebar.tsx` — add a `NAV_ENTRIES` row (`moduleId: "mobile-apps"`).
- `components/modules/modules-provider.tsx` — (optional) add `"mobile-apps"` to optimistic default set only if it should default-on (it should NOT — leave it off by default; no change needed beyond verifying).
- `package.json` — add `google-play-scraper` dependency.

---

# PHASE A — Module foundations + live reviews/ratings (ships working software)

End state of Phase A: enable the module in Settings → a **Mobile Applications** nav entry appears → add an app by pasting its App Store and/or Play URL → the detail page shows live reviews and the current star rating, refreshable on demand.

---

### Task A1: Register the module (registry + nav, no DB yet)

**Files:**
- Modify: `lib/modules/registry.ts:28-34` (union) and `lib/modules/registry.ts:51-127` (MODULES array)
- Modify: `components/layout/app-sidebar.tsx:41-52` (NAV_ENTRIES)

- [ ] **Step 1: Add the module id to the union**

In `lib/modules/registry.ts`, change the `ModuleId` type to include the new id:

```ts
export type ModuleId =
  | "kanban"
  | "agenda"
  | "processes"
  | "documents"
  | "metrics"
  | "mobile-apps"
  | "system";
```

- [ ] **Step 2: Add the MODULES entry**

In `lib/modules/registry.ts`, import the device icon and add an entry to the `MODULES` array (place it right after the `metrics` entry, before `system`). Update the icon import line near the top to include `IconDeviceMobile`:

```ts
import {
  IconCalendar,
  IconChartBar,
  IconDashboard,
  IconDeviceMobile,
  IconFileText,
  IconListDetails,
  IconRobot,
  IconStack2,
} from "@tabler/icons-react";
```

```ts
  {
    id: "mobile-apps",
    name: "Mobile Applications",
    description:
      "Track your apps' App Store + Google Play reviews and ratings in real time, with ratings-over-time charts, agent sentiment digests, and threshold alerts. Disabling permanently deletes all tracked apps, fetched reviews, rating history, digests, and alert rules.",
    icon: IconDeviceMobile,
    core: false,
    nav: { title: "Mobile Applications", url: "/mobile-apps" },
    tables: [
      "mobile_apps",
      "mobile_app_listings",
      "app_reviews",
      "app_rating_snapshots",
      "app_review_digests",
      "app_alert_rules",
    ],
  },
```

- [ ] **Step 3: Add the sidebar nav entry**

In `components/layout/app-sidebar.tsx`, import `IconDeviceMobile` alongside the other `@tabler/icons-react` imports, then add this row to `NAV_ENTRIES` (after the Metrics row, line ~45):

```ts
  { title: "Mobile Applications", url: "/mobile-apps", icon: IconDeviceMobile, moduleId: "mobile-apps" },
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (At this point the nav row will appear once the module is enabled, but the page 404s until Task A6 — that's fine.)

- [ ] **Step 5: Commit**

```bash
git add lib/modules/registry.ts components/layout/app-sidebar.tsx
git commit -m "feat(mobile-apps): register Mobile Applications module + nav entry"
```

---

### Task A2: Module handler (DB schema setup/preview/cleanup)

**Files:**
- Create: `lib/modules/handlers/mobile-apps.ts`
- Modify: `app/api/modules/route.ts:6-22`

- [ ] **Step 1: Write the handler with the 6-table schema**

Create `lib/modules/handlers/mobile-apps.ts`:

```ts
import type { getSql } from "@/lib/local-db";

type Sql = ReturnType<typeof getSql>;

/**
 * Creates / drops the tables exclusively owned by the Mobile Applications module.
 * Mirrors the metricsHandler shape (preview/cleanup/setup) wired in app/api/modules/route.ts.
 */
export const mobileAppsHandler = {
  async preview(sql: Sql) {
    const [apps, reviews] = await Promise.all([
      sql`select count(*)::int as n from mobile_apps`.catch(() => [{ n: 0 }]),
      sql`select count(*)::int as n from app_reviews`.catch(() => [{ n: 0 }]),
    ]);
    const sampleApps = (await sql`
      select name from mobile_apps order by created_at desc limit 5
    `.catch(() => [])) as Array<{ name: string }>;

    return {
      counts: [
        { icon: "📱", label: "tracked apps", n: Number((apps as Array<{ n: number }>)[0]?.n ?? 0) },
        { icon: "⭐", label: "fetched reviews", n: Number((reviews as Array<{ n: number }>)[0]?.n ?? 0) },
      ],
      bytesOnDisk: null,
      sampleAffected: sampleApps.map((a) => ({ kind: "app", label: a.name })),
      finalWarning:
        "Disabling Mobile Applications permanently deletes every tracked app, fetched review, rating snapshot, digest, and alert rule. The app stores are not affected.",
    };
  },

  async cleanup(sql: Sql): Promise<void> {
    await sql`DROP TABLE IF EXISTS app_alert_rules CASCADE`;
    await sql`DROP TABLE IF EXISTS app_review_digests CASCADE`;
    await sql`DROP TABLE IF EXISTS app_rating_snapshots CASCADE`;
    await sql`DROP TABLE IF EXISTS app_reviews CASCADE`;
    await sql`DROP TABLE IF EXISTS mobile_app_listings CASCADE`;
    await sql`DROP TABLE IF EXISTS mobile_apps CASCADE`;
  },

  async setup(sql: Sql): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS mobile_apps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name text NOT NULL,
        icon_url text,
        notes text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS mobile_apps_workspace_idx ON mobile_apps(workspace_id)`;

    await sql`
      CREATE TABLE IF NOT EXISTS mobile_app_listings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile_app_id uuid NOT NULL REFERENCES mobile_apps(id) ON DELETE CASCADE,
        store text NOT NULL,
        store_app_id text NOT NULL,
        country text NOT NULL DEFAULT 'us',
        current_rating numeric(3,2),
        ratings_count integer,
        last_synced_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (mobile_app_id, store)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS mobile_app_listings_app_idx ON mobile_app_listings(mobile_app_id)`;

    await sql`
      CREATE TABLE IF NOT EXISTS app_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id uuid NOT NULL REFERENCES mobile_app_listings(id) ON DELETE CASCADE,
        store_review_id text NOT NULL,
        author text,
        rating integer,
        title text,
        body text,
        app_version text,
        country text,
        submitted_at timestamptz,
        store_response text,
        sentiment text,
        themes text[],
        fetched_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (listing_id, store_review_id)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS app_reviews_listing_idx ON app_reviews(listing_id, submitted_at desc)`;

    await sql`
      CREATE TABLE IF NOT EXISTS app_rating_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id uuid NOT NULL REFERENCES mobile_app_listings(id) ON DELETE CASCADE,
        captured_at timestamptz NOT NULL DEFAULT now(),
        avg_rating numeric(3,2),
        ratings_count integer,
        histogram jsonb
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS app_rating_snapshots_listing_idx ON app_rating_snapshots(listing_id, captured_at desc)`;

    await sql`
      CREATE TABLE IF NOT EXISTS app_review_digests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile_app_id uuid NOT NULL REFERENCES mobile_apps(id) ON DELETE CASCADE,
        period_start timestamptz,
        period_end timestamptz,
        summary_md text NOT NULL,
        sentiment_score numeric(4,3),
        top_themes jsonb,
        generated_by_agent_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS app_review_digests_app_idx ON app_review_digests(mobile_app_id, created_at desc)`;

    await sql`
      CREATE TABLE IF NOT EXISTS app_alert_rules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile_app_id uuid REFERENCES mobile_apps(id) ON DELETE CASCADE,
        metric text NOT NULL,
        operator text NOT NULL DEFAULT 'lt',
        threshold numeric NOT NULL,
        window text NOT NULL DEFAULT 'daily',
        channel_ids text[] NOT NULL DEFAULT '{}'::text[],
        enabled boolean NOT NULL DEFAULT true,
        last_fired_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;
  },
};
```

- [ ] **Step 2: Register the handler in the modules route**

In `app/api/modules/route.ts`, add the import after the `metricsHandler` import (line 7):

```ts
import { mobileAppsHandler } from "@/lib/modules/handlers/mobile-apps";
```

and add it to the `HANDLERS` map (after the `metrics` line, ~line 21):

```ts
const HANDLERS: Partial<Record<ModuleId, typeof documentsHandler>> = {
  documents: documentsHandler,
  metrics: metricsHandler,
  "mobile-apps": mobileAppsHandler,
};
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify enable/disable runs the schema end-to-end**

Run the dev server (`npm run dev`), open Settings → Modules, enable **Mobile Applications**, then disable it (typed-confirm) and re-enable. Expected: no errors in the server log; toggling persists. (This exercises `setup`/`preview`/`cleanup`.)

- [ ] **Step 5: Commit**

```bash
git add lib/modules/handlers/mobile-apps.ts app/api/modules/route.ts
git commit -m "feat(mobile-apps): module handler with 6-table schema (setup/preview/cleanup)"
```

---

### Task A3: Shared types + URL/ID resolver (pure, tested)

**Files:**
- Create: `lib/mobile-apps/types.ts`
- Create: `lib/mobile-apps/resolve.ts`
- Test: `scripts/mobile-apps/resolve.test.mjs`

- [ ] **Step 1: Write the shared types**

Create `lib/mobile-apps/types.ts`:

```ts
export type Store = "apple" | "google";

/** A review as returned by a provider, before it is persisted. */
export type RawReview = {
  storeReviewId: string;
  author: string | null;
  rating: number | null;
  title: string | null;
  body: string | null;
  appVersion: string | null;
  country: string | null;
  submittedAt: string | null; // ISO 8601
  storeResponse: string | null;
};

export type RatingSummary = {
  avgRating: number | null;
  ratingsCount: number | null;
  /** 1→5 star counts, e.g. { "1": 3, "2": 1, "3": 0, "4": 8, "5": 42 } */
  histogram: Record<string, number> | null;
  /** Provider-discovered display name / icon, used when first adding an app. */
  name?: string | null;
  iconUrl?: string | null;
};

export type ListingRef = {
  store: Store;
  storeAppId: string;
  country: string;
};

export interface ReviewProvider {
  fetchReviews(ref: ListingRef): Promise<RawReview[]>;
  fetchRatingSummary(ref: ListingRef): Promise<RatingSummary>;
}

/** Result of parsing a pasted store URL or raw id. */
export type ResolvedListing = {
  store: Store;
  storeAppId: string;
  country: string;
};
```

- [ ] **Step 2: Write the failing resolver test**

Create `scripts/mobile-apps/resolve.test.mjs`:

```js
import assert from "node:assert/strict";
import { resolveListing } from "../../lib/mobile-apps/resolve.ts";

// Apple URL with country + numeric id
let r = resolveListing("https://apps.apple.com/nl/app/whatsapp-messenger/id310633997");
assert.equal(r.store, "apple");
assert.equal(r.storeAppId, "310633997");
assert.equal(r.country, "nl");

// Apple URL without country defaults to us
r = resolveListing("https://apps.apple.com/app/id310633997");
assert.equal(r.store, "apple");
assert.equal(r.storeAppId, "310633997");
assert.equal(r.country, "us");

// Google Play URL with hl/gl
r = resolveListing("https://play.google.com/store/apps/details?id=com.whatsapp&hl=en&gl=NL");
assert.equal(r.store, "google");
assert.equal(r.storeAppId, "com.whatsapp");
assert.equal(r.country, "nl");

// Bare numeric id → apple
r = resolveListing("310633997");
assert.equal(r.store, "apple");
assert.equal(r.storeAppId, "310633997");

// Bare package id → google
r = resolveListing("com.whatsapp");
assert.equal(r.store, "google");
assert.equal(r.storeAppId, "com.whatsapp");

// Garbage throws
assert.throws(() => resolveListing("not a url or id"));

console.log("ok - resolveListing");
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `node --experimental-strip-types scripts/mobile-apps/resolve.test.mjs`
Expected: FAIL — `Cannot find module ... resolve.ts` (or "resolveListing is not a function").

> Note: Node 24 (project requirement) supports `--experimental-strip-types` to import `.ts` directly. If that flag errors on the installed Node, run via `npx tsx scripts/mobile-apps/resolve.test.mjs` instead (tsx is available transitively); use whichever the repo already uses for `.ts` scripts.

- [ ] **Step 4: Implement the resolver**

Create `lib/mobile-apps/resolve.ts`:

```ts
import type { ResolvedListing } from "@/lib/mobile-apps/types";

/**
 * Parse a pasted App Store / Google Play URL — or a raw store id — into a
 * { store, storeAppId, country } triple. Throws if nothing matches.
 *
 * Apple ids are numeric (e.g. 310633997). Google ids are reverse-DNS
 * package names (e.g. com.whatsapp).
 */
export function resolveListing(input: string): ResolvedListing {
  const raw = (input || "").trim();
  if (!raw) throw new Error("Empty app reference");

  // Apple URL: https://apps.apple.com/<country>/app/<slug>/id<digits>
  const appleUrl = raw.match(/apps\.apple\.com\/(?:([a-z]{2})\/)?app\/(?:[^/]+\/)?id(\d+)/i);
  if (appleUrl) {
    return { store: "apple", storeAppId: appleUrl[2], country: (appleUrl[1] || "us").toLowerCase() };
  }

  // Google Play URL: https://play.google.com/store/apps/details?id=<pkg>&gl=<cc>
  const googleUrl = raw.match(/play\.google\.com\/store\/apps\/details\?([^\s]+)/i);
  if (googleUrl) {
    const params = new URLSearchParams(googleUrl[1]);
    const id = params.get("id");
    if (!id) throw new Error("Google Play URL missing ?id=");
    const country = (params.get("gl") || "us").toLowerCase();
    return { store: "google", storeAppId: id, country };
  }

  // Bare numeric id → apple
  if (/^\d+$/.test(raw)) {
    return { store: "apple", storeAppId: raw, country: "us" };
  }

  // Bare reverse-DNS package → google
  if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i.test(raw)) {
    return { store: "google", storeAppId: raw, country: "us" };
  }

  throw new Error(`Could not recognize an App Store or Google Play app from: ${raw}`);
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `node --experimental-strip-types scripts/mobile-apps/resolve.test.mjs`
Expected: `ok - resolveListing`

- [ ] **Step 6: Commit**

```bash
git add lib/mobile-apps/types.ts lib/mobile-apps/resolve.ts scripts/mobile-apps/resolve.test.mjs
git commit -m "feat(mobile-apps): shared types + tested store URL/id resolver"
```

---

### Task A4: Apple provider (RSS reviews + iTunes Lookup), pure parsers tested

**Files:**
- Create: `lib/mobile-apps/providers/apple.ts`
- Test: `scripts/mobile-apps/apple-parse.test.mjs`

- [ ] **Step 1: Write the failing parser test**

Create `scripts/mobile-apps/apple-parse.test.mjs`:

```js
import assert from "node:assert/strict";
import { parseAppleReviews, parseiTunesLookup } from "../../lib/mobile-apps/providers/apple.ts";

const rssFeed = {
  feed: {
    entry: [
      // First entry in Apple's review RSS is app metadata (no im:rating) — must be skipped
      { "im:name": { label: "Demo App" }, id: { label: "310633997" } },
      {
        id: { label: "1234567890" },
        author: { name: { label: "Jane" } },
        "im:rating": { label: "5" },
        title: { label: "Love it" },
        content: { label: "Works great" },
        "im:version": { label: "2.1.0" },
        updated: { label: "2026-06-01T10:00:00-07:00" },
      },
    ],
  },
};

const reviews = parseAppleReviews(rssFeed, "us");
assert.equal(reviews.length, 1);
assert.equal(reviews[0].storeReviewId, "1234567890");
assert.equal(reviews[0].author, "Jane");
assert.equal(reviews[0].rating, 5);
assert.equal(reviews[0].title, "Love it");
assert.equal(reviews[0].body, "Works great");
assert.equal(reviews[0].appVersion, "2.1.0");
assert.equal(reviews[0].country, "us");

// Empty / single-entry feed → no reviews, no throw
assert.deepEqual(parseAppleReviews({ feed: {} }, "us"), []);

const lookup = {
  resultCount: 1,
  results: [
    {
      trackName: "Demo App",
      averageUserRating: 4.567,
      userRatingCount: 1234,
      version: "2.1.0",
      artworkUrl512: "https://example/icon.png",
    },
  ],
};
const summary = parseiTunesLookup(lookup);
assert.equal(summary.name, "Demo App");
assert.equal(summary.avgRating, 4.57); // rounded to 2dp
assert.equal(summary.ratingsCount, 1234);
assert.equal(summary.iconUrl, "https://example/icon.png");

console.log("ok - apple parsers");
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --experimental-strip-types scripts/mobile-apps/apple-parse.test.mjs`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement the Apple provider**

Create `lib/mobile-apps/providers/apple.ts`:

```ts
import type { ListingRef, RatingSummary, RawReview, ReviewProvider } from "@/lib/mobile-apps/types";

type AppleEntry = {
  id?: { label?: string };
  author?: { name?: { label?: string } };
  "im:rating"?: { label?: string };
  "im:version"?: { label?: string };
  title?: { label?: string };
  content?: { label?: string };
  updated?: { label?: string };
};

function round2(n: number | null): number | null {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

/** Pure: turn an Apple customer-reviews RSS JSON object into RawReview[]. */
export function parseAppleReviews(feedJson: unknown, country: string): RawReview[] {
  const feed = (feedJson as { feed?: { entry?: AppleEntry | AppleEntry[] } })?.feed;
  if (!feed?.entry) return [];
  const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];

  const out: RawReview[] = [];
  for (const e of entries) {
    const ratingLabel = e["im:rating"]?.label;
    // The app-metadata entry has no im:rating — skip it.
    if (ratingLabel == null) continue;
    const id = e.id?.label;
    if (!id) continue;
    out.push({
      storeReviewId: String(id),
      author: e.author?.name?.label ?? null,
      rating: Number.isFinite(Number(ratingLabel)) ? Number(ratingLabel) : null,
      title: e.title?.label ?? null,
      body: e.content?.label ?? null,
      appVersion: e["im:version"]?.label ?? null,
      country,
      submittedAt: e.updated?.label ? new Date(e.updated.label).toISOString() : null,
      storeResponse: null,
    });
  }
  return out;
}

/** Pure: turn an iTunes Lookup response into a RatingSummary. */
export function parseiTunesLookup(lookupJson: unknown): RatingSummary {
  const r = (lookupJson as { results?: Array<Record<string, unknown>> })?.results?.[0];
  if (!r) return { avgRating: null, ratingsCount: null, histogram: null };
  return {
    avgRating: round2(typeof r.averageUserRating === "number" ? r.averageUserRating : null),
    ratingsCount: typeof r.userRatingCount === "number" ? r.userRatingCount : null,
    histogram: null, // iTunes Lookup does not expose a per-star histogram
    name: typeof r.trackName === "string" ? r.trackName : null,
    iconUrl:
      (typeof r.artworkUrl512 === "string" && r.artworkUrl512) ||
      (typeof r.artworkUrl100 === "string" && r.artworkUrl100) ||
      null,
  };
}

export class AppleProvider implements ReviewProvider {
  async fetchReviews(ref: ListingRef): Promise<RawReview[]> {
    // Apple paginates 1..10; pull the first few pages of most-recent reviews.
    const all: RawReview[] = [];
    for (let page = 1; page <= 5; page++) {
      const url = `https://itunes.apple.com/${encodeURIComponent(ref.country)}/rss/customerreviews/page=${page}/id=${encodeURIComponent(ref.storeAppId)}/sortby=mostrecent/json`;
      const res = await fetch(url, { headers: { "User-Agent": "MissionControl/1.0" } });
      if (!res.ok) break;
      const json = await res.json();
      const batch = parseAppleReviews(json, ref.country);
      if (batch.length === 0) break;
      all.push(...batch);
    }
    return all;
  }

  async fetchRatingSummary(ref: ListingRef): Promise<RatingSummary> {
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(ref.storeAppId)}&country=${encodeURIComponent(ref.country)}`;
    const res = await fetch(url, { headers: { "User-Agent": "MissionControl/1.0" } });
    if (!res.ok) return { avgRating: null, ratingsCount: null, histogram: null };
    return parseiTunesLookup(await res.json());
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --experimental-strip-types scripts/mobile-apps/apple-parse.test.mjs`
Expected: `ok - apple parsers`

- [ ] **Step 5: Commit**

```bash
git add lib/mobile-apps/providers/apple.ts scripts/mobile-apps/apple-parse.test.mjs
git commit -m "feat(mobile-apps): Apple provider (RSS reviews + iTunes lookup) with tested parsers"
```

---

### Task A5: Google provider (`google-play-scraper`), pure mappers tested

**Files:**
- Modify: `package.json` (add dependency)
- Create: `lib/mobile-apps/providers/google.ts`
- Create: `lib/mobile-apps/providers/index.ts`
- Test: `scripts/mobile-apps/google-map.test.mjs`

- [ ] **Step 1: Add the dependency**

Run: `npm install google-play-scraper@^10`
Expected: `package.json` gains `"google-play-scraper": "^10.x"` under dependencies; `package-lock.json` updated.

- [ ] **Step 2: Write the failing mapper test**

Create `scripts/mobile-apps/google-map.test.mjs`:

```js
import assert from "node:assert/strict";
import { mapGoogleReviews, mapGoogleApp } from "../../lib/mobile-apps/providers/google.ts";

const rawReviews = [
  {
    id: "gp:AOqpTOabc",
    userName: "Sam",
    score: 4,
    title: null,
    text: "Pretty good",
    version: "3.0.1",
    date: "2026-05-30T08:00:00.000Z",
    replyText: "Thanks Sam!",
  },
];
const mapped = mapGoogleReviews(rawReviews, "nl");
assert.equal(mapped.length, 1);
assert.equal(mapped[0].storeReviewId, "gp:AOqpTOabc");
assert.equal(mapped[0].author, "Sam");
assert.equal(mapped[0].rating, 4);
assert.equal(mapped[0].body, "Pretty good");
assert.equal(mapped[0].appVersion, "3.0.1");
assert.equal(mapped[0].country, "nl");
assert.equal(mapped[0].storeResponse, "Thanks Sam!");

const app = {
  title: "Demo App",
  score: 4.321,
  ratings: 9876,
  icon: "https://example/icon.png",
  histogram: { 1: 100, 2: 50, 3: 200, 4: 1000, 5: 8526 },
};
const summary = mapGoogleApp(app);
assert.equal(summary.name, "Demo App");
assert.equal(summary.avgRating, 4.32);
assert.equal(summary.ratingsCount, 9876);
assert.deepEqual(summary.histogram, { "1": 100, "2": 50, "3": 200, "4": 1000, "5": 8526 });

console.log("ok - google mappers");
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `node --experimental-strip-types scripts/mobile-apps/google-map.test.mjs`
Expected: FAIL — module/function not found.

- [ ] **Step 4: Implement the Google provider + factory**

Create `lib/mobile-apps/providers/google.ts`:

```ts
import type { ListingRef, RatingSummary, RawReview, ReviewProvider } from "@/lib/mobile-apps/types";

type GpReview = {
  id?: string;
  userName?: string;
  score?: number;
  title?: string | null;
  text?: string | null;
  version?: string | null;
  date?: string | Date | null;
  replyText?: string | null;
};

type GpApp = {
  title?: string;
  score?: number;
  ratings?: number;
  icon?: string;
  histogram?: Record<string | number, number>;
};

function round2(n: number | null): number | null {
  return n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}

/** Pure: map google-play-scraper review objects to RawReview[]. */
export function mapGoogleReviews(raw: GpReview[], country: string): RawReview[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && r.id)
    .map((r) => ({
      storeReviewId: String(r.id),
      author: r.userName ?? null,
      rating: typeof r.score === "number" ? r.score : null,
      title: r.title ?? null,
      body: r.text ?? null,
      appVersion: r.version ?? null,
      country,
      submittedAt: r.date ? new Date(r.date).toISOString() : null,
      storeResponse: r.replyText ?? null,
    }));
}

/** Pure: map a google-play-scraper app object to a RatingSummary. */
export function mapGoogleApp(app: GpApp): RatingSummary {
  const hist = app?.histogram
    ? Object.fromEntries(Object.entries(app.histogram).map(([k, v]) => [String(k), Number(v)]))
    : null;
  return {
    avgRating: round2(typeof app?.score === "number" ? app.score : null),
    ratingsCount: typeof app?.ratings === "number" ? app.ratings : null,
    histogram: hist,
    name: typeof app?.title === "string" ? app.title : null,
    iconUrl: typeof app?.icon === "string" ? app.icon : null,
  };
}

export class GoogleProvider implements ReviewProvider {
  async fetchReviews(ref: ListingRef): Promise<RawReview[]> {
    const gplay = (await import("google-play-scraper")).default;
    const result = await gplay.reviews({
      appId: ref.storeAppId,
      country: ref.country,
      sort: gplay.sort.NEWEST,
      num: 200,
    });
    const data = Array.isArray(result) ? result : (result?.data ?? []);
    return mapGoogleReviews(data as GpReview[], ref.country);
  }

  async fetchRatingSummary(ref: ListingRef): Promise<RatingSummary> {
    const gplay = (await import("google-play-scraper")).default;
    const app = await gplay.app({ appId: ref.storeAppId, country: ref.country });
    return mapGoogleApp(app as GpApp);
  }
}
```

Create `lib/mobile-apps/providers/index.ts`:

```ts
import type { ReviewProvider, Store } from "@/lib/mobile-apps/types";
import { AppleProvider } from "@/lib/mobile-apps/providers/apple";
import { GoogleProvider } from "@/lib/mobile-apps/providers/google";

const apple = new AppleProvider();
const google = new GoogleProvider();

/** Returns the provider for a store. Swapping in official APIs later = change here only. */
export function getProvider(store: Store): ReviewProvider {
  return store === "apple" ? apple : google;
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `node --experimental-strip-types scripts/mobile-apps/google-map.test.mjs`
Expected: `ok - google mappers`

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/mobile-apps/providers/google.ts lib/mobile-apps/providers/index.ts scripts/mobile-apps/google-map.test.mjs
git commit -m "feat(mobile-apps): Google Play provider + provider factory with tested mappers"
```

---

### Task A6: Sync engine + sync route (live fetch → upsert → snapshot → notify)

**Files:**
- Create: `lib/mobile-apps/sync.ts`
- Create: `app/api/mobile-apps/sync/route.ts`

- [ ] **Step 1: Implement the sync engine**

Create `lib/mobile-apps/sync.ts`:

```ts
import { getSql } from "@/lib/local-db";
import { getProvider } from "@/lib/mobile-apps/providers";
import type { Store } from "@/lib/mobile-apps/types";

type Sql = ReturnType<typeof getSql>;

type ListingRow = {
  id: string;
  store: string;
  store_app_id: string;
  country: string;
  last_synced_at: string | null;
};

export type SyncResult = {
  listingId: string;
  store: Store;
  inserted: number;
  ratingCaptured: boolean;
  skipped: boolean;
  error: string | null;
};

const DEFAULT_DEDUPE_MS = 60_000;

/**
 * Sync one app: for each of its listings, fetch reviews + rating summary,
 * upsert reviews (dedup on store_review_id), write a fresh rating snapshot,
 * and update the listing's current_rating / last_synced_at.
 *
 * @param force when true, ignore the de-dupe window (manual "Refresh now").
 */
export async function syncApp(
  appId: string,
  opts: { force?: boolean; dedupeMs?: number } = {},
): Promise<SyncResult[]> {
  const sql = getSql();
  const dedupeMs = opts.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const listings = (await sql`
    select id::text, store, store_app_id, country, last_synced_at
    from mobile_app_listings
    where mobile_app_id = ${appId}
  `) as unknown as ListingRow[];

  const results: SyncResult[] = [];
  for (const l of listings) {
    const store = l.store as Store;
    const recentlySynced =
      l.last_synced_at && Date.now() - new Date(l.last_synced_at).getTime() < dedupeMs;
    if (!opts.force && recentlySynced) {
      results.push({ listingId: l.id, store, inserted: 0, ratingCaptured: false, skipped: true, error: null });
      continue;
    }

    try {
      const provider = getProvider(store);
      const ref = { store, storeAppId: l.store_app_id, country: l.country };
      const [reviews, summary] = await Promise.all([
        provider.fetchReviews(ref),
        provider.fetchRatingSummary(ref),
      ]);

      let inserted = 0;
      for (const r of reviews) {
        const res = await sql`
          insert into app_reviews (
            listing_id, store_review_id, author, rating, title, body,
            app_version, country, submitted_at, store_response
          ) values (
            ${l.id}, ${r.storeReviewId}, ${r.author}, ${r.rating}, ${r.title}, ${r.body},
            ${r.appVersion}, ${r.country}, ${r.submittedAt}, ${r.storeResponse}
          )
          on conflict (listing_id, store_review_id) do update
            set store_response = excluded.store_response
          returning (xmax = 0) as inserted
        `;
        if ((res as unknown as Array<{ inserted: boolean }>)[0]?.inserted) inserted += 1;
      }

      await sql`
        insert into app_rating_snapshots (listing_id, avg_rating, ratings_count, histogram)
        values (${l.id}, ${summary.avgRating}, ${summary.ratingsCount}, ${
          summary.histogram ? JSON.stringify(summary.histogram) : null
        })
      `;

      await sql`
        update mobile_app_listings
        set current_rating = ${summary.avgRating},
            ratings_count = ${summary.ratingsCount},
            last_synced_at = now()
        where id = ${l.id}
      `;

      results.push({ listingId: l.id, store, inserted, ratingCaptured: true, skipped: false, error: null });
    } catch (err) {
      results.push({
        listingId: l.id,
        store,
        inserted: 0,
        ratingCaptured: false,
        skipped: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Notify SSE listeners that this app changed.
  await sql`select pg_notify('mobile_apps_change', ${JSON.stringify({ appId })})`.catch(() => null);
  return results;
}
```

> Note on `xmax = 0`: this is the standard Postgres trick to detect whether an `INSERT ... ON CONFLICT` actually inserted (true) vs. updated (false).

- [ ] **Step 2: Implement the sync route**

Create `app/api/mobile-apps/sync/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { syncApp } from "@/lib/mobile-apps/sync";
import { getSql } from "@/lib/local-db";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const body = (await request.json().catch(() => ({}))) as { appId?: string; force?: boolean };
    const force = Boolean(body.force);

    const sql = getSql();
    let appIds: string[];
    if (body.appId) {
      appIds = [body.appId];
    } else {
      const rows = (await sql`select id::text from mobile_apps`) as unknown as Array<{ id: string }>;
      appIds = rows.map((r) => r.id);
    }

    const results = [];
    for (const id of appIds) {
      results.push({ appId: id, listings: await syncApp(id, { force }) });
    }
    return ok({ results });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Sync failed", 500);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/mobile-apps/sync.ts app/api/mobile-apps/sync/route.ts
git commit -m "feat(mobile-apps): sync engine + POST /api/mobile-apps/sync"
```

---

### Task A7: Apps CRUD route (add by URL/ID, list, delete)

**Files:**
- Create: `app/api/mobile-apps/route.ts`

- [ ] **Step 1: Implement the route**

Create `app/api/mobile-apps/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { resolveListing } from "@/lib/mobile-apps/resolve";
import { getProvider } from "@/lib/mobile-apps/providers";
import { syncApp } from "@/lib/mobile-apps/sync";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const sql = getSql();
    const wid = await workspaceId(sql);
    if (!wid) return ok({ apps: [] });

    const apps = await sql`
      select
        a.id::text,
        a.name,
        a.icon_url,
        a.notes,
        coalesce(
          json_agg(
            json_build_object(
              'id', l.id::text,
              'store', l.store,
              'storeAppId', l.store_app_id,
              'country', l.country,
              'currentRating', l.current_rating,
              'ratingsCount', l.ratings_count,
              'lastSyncedAt', l.last_synced_at
            )
          ) filter (where l.id is not null),
          '[]'
        ) as listings
      from mobile_apps a
      left join mobile_app_listings l on l.mobile_app_id = a.id
      where a.workspace_id = ${wid}
      group by a.id
      order by a.created_at asc
    `;
    return ok({ apps });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to list apps", 500);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const sql = getSql();
    const wid = await workspaceId(sql);
    if (!wid) return fail("Workspace not found", 500);

    const body = (await request.json()) as { name?: string; refs?: string[] };
    const refs = (Array.isArray(body.refs) ? body.refs : []).map((s) => String(s || "").trim()).filter(Boolean);
    if (refs.length === 0) return fail("Provide at least one App Store or Play Store URL/ID.");

    // Resolve all refs first so a bad one fails before we create anything.
    const resolved = refs.map(resolveListing);

    // Discover a display name/icon from the first listing's provider.
    let name = String(body.name || "").trim();
    let iconUrl: string | null = null;
    try {
      const first = resolved[0];
      const summary = await getProvider(first.store).fetchRatingSummary(first);
      if (!name) name = summary.name || "Untitled app";
      iconUrl = summary.iconUrl ?? null;
    } catch {
      if (!name) name = "Untitled app";
    }

    const appRows = (await sql`
      insert into mobile_apps (workspace_id, name, icon_url)
      values (${wid}, ${name}, ${iconUrl})
      returning id::text
    `) as unknown as Array<{ id: string }>;
    const appId = appRows[0].id;

    for (const r of resolved) {
      await sql`
        insert into mobile_app_listings (mobile_app_id, store, store_app_id, country)
        values (${appId}, ${r.store}, ${r.storeAppId}, ${r.country})
        on conflict (mobile_app_id, store) do nothing
      `;
    }

    // Kick off an immediate forced sync so the app isn't empty on first view.
    await syncApp(appId, { force: true }).catch(() => null);

    return ok({ id: appId, name });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to add app", 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const sql = getSql();
    const body = (await request.json()) as { id?: string };
    const id = String(body.id || "");
    if (!id) return fail("App id is required.");
    await sql`delete from mobile_apps where id = ${id}`;
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to delete app", 500);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke test end-to-end**

With dev server running and the module enabled, run (replace creds with your `API_USER`/`API_PASS`):

```bash
curl -s -u "$API_USER:$API_PASS" -X POST http://localhost:3000/api/mobile-apps \
  -H 'content-type: application/json' \
  -d '{"refs":["https://apps.apple.com/us/app/id310633997","com.whatsapp"]}'
```

Expected: `{"ok":true,"id":"<uuid>","name":"..."}`. Then:

```bash
curl -s -u "$API_USER:$API_PASS" http://localhost:3000/api/mobile-apps
```

Expected: JSON with the app and two listings; `currentRating` populated for at least one store.

- [ ] **Step 4: Commit**

```bash
git add app/api/mobile-apps/route.ts
git commit -m "feat(mobile-apps): apps CRUD route (add by URL/ID, list, delete) with first-sync"
```

---

### Task A8: App detail route (listings + filtered reviews + snapshots)

**Files:**
- Create: `app/api/mobile-apps/[id]/route.ts`

- [ ] **Step 1: Implement the detail route**

Create `app/api/mobile-apps/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const { id } = await ctx.params;
    const sql = getSql();
    const url = new URL(request.url);
    const store = url.searchParams.get("store"); // 'apple' | 'google' | null
    const minRating = Number(url.searchParams.get("minRating") || "0");
    const limit = Math.min(Number(url.searchParams.get("limit") || "100"), 500);

    const appRows = (await sql`
      select id::text, name, icon_url, notes from mobile_apps where id = ${id} limit 1
    `) as unknown as Array<Record<string, unknown>>;
    if (!appRows[0]) return fail("App not found", 404);

    const listings = (await sql`
      select id::text, store, store_app_id, country, current_rating, ratings_count, last_synced_at
      from mobile_app_listings where mobile_app_id = ${id}
    `) as unknown as Array<{ id: string; store: string }>;
    const listingIds = listings.map((l) => l.id);

    const reviews =
      listingIds.length === 0
        ? []
        : await sql`
            select
              r.id::text, r.listing_id::text, l.store, r.author, r.rating, r.title, r.body,
              r.app_version, r.country, r.submitted_at, r.store_response, r.sentiment, r.themes
            from app_reviews r
            join mobile_app_listings l on l.id = r.listing_id
            where r.listing_id = any(${sql.array(listingIds)})
              and (${store}::text is null or l.store = ${store})
              and (r.rating is null or r.rating >= ${minRating})
            order by r.submitted_at desc nulls last
            limit ${limit}
          `;

    const snapshots =
      listingIds.length === 0
        ? []
        : await sql`
            select s.listing_id::text, l.store, s.captured_at, s.avg_rating, s.ratings_count, s.histogram
            from app_rating_snapshots s
            join mobile_app_listings l on l.id = s.listing_id
            where s.listing_id = any(${sql.array(listingIds)})
            order by s.captured_at asc
          `;

    return ok({ app: appRows[0], listings, reviews, snapshots });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load app", 500);
  }
}
```

- [ ] **Step 2: Typecheck + smoke**

Run: `npx tsc --noEmit` (expect no errors), then with the app id from Task A7:

```bash
curl -s -u "$API_USER:$API_PASS" "http://localhost:3000/api/mobile-apps/<id>?store=apple&minRating=1"
```

Expected: `{"ok":true,"app":{...},"listings":[...],"reviews":[...],"snapshots":[...]}`.

- [ ] **Step 3: Commit**

```bash
git add "app/api/mobile-apps/[id]/route.ts"
git commit -m "feat(mobile-apps): app detail route (listings + filtered reviews + snapshots)"
```

---

### Task A9: Page shells (list + detail) and review card

**Files:**
- Create: `app/mobile-apps/page.tsx`
- Create: `app/mobile-apps/[id]/page.tsx`
- Create: `components/mobile-apps/review-card.tsx`

- [ ] **Step 1: Create the list page shell**

Create `app/mobile-apps/page.tsx` (mirrors `app/metrics/page.tsx`):

```tsx
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
```

- [ ] **Step 2: Create the detail page shell**

Create `app/mobile-apps/[id]/page.tsx`:

```tsx
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppDetailClient } from "@/components/mobile-apps/app-detail-client";

export const dynamic = "force-dynamic";

export default async function MobileAppDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
```

- [ ] **Step 3: Create the review card**

Create `components/mobile-apps/review-card.tsx`:

```tsx
"use client";

import { IconStarFilled, IconBrandApple, IconBrandGooglePlay } from "@tabler/icons-react";

export type ReviewRow = {
  id: string;
  store: string;
  author: string | null;
  rating: number | null;
  title: string | null;
  body: string | null;
  app_version: string | null;
  country: string | null;
  submitted_at: string | null;
  store_response: string | null;
  sentiment: string | null;
  themes: string[] | null;
};

function Stars({ n }: { n: number | null }) {
  const count = Math.max(0, Math.min(5, Math.round(n ?? 0)));
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <IconStarFilled
          key={i}
          className={i < count ? "size-3.5 text-amber-500" : "size-3.5 text-muted-foreground/30"}
        />
      ))}
    </span>
  );
}

export function ReviewCard({ review }: { review: ReviewRow }) {
  const StoreIcon = review.store === "apple" ? IconBrandApple : IconBrandGooglePlay;
  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StoreIcon className="size-4 text-muted-foreground" />
          <Stars n={review.rating} />
          <span className="font-medium">{review.title || "—"}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {review.submitted_at ? new Date(review.submitted_at).toLocaleDateString() : ""}
        </div>
      </div>
      {review.body ? <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{review.body}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {review.author ? <span>{review.author}</span> : null}
        {review.app_version ? <span>· v{review.app_version}</span> : null}
        {review.country ? <span>· {review.country.toUpperCase()}</span> : null}
        {review.sentiment ? (
          <span className="rounded bg-muted px-1.5 py-0.5 capitalize">{review.sentiment}</span>
        ) : null}
      </div>
      {review.store_response ? (
        <div className="mt-2 rounded border-l-2 border-primary/50 bg-muted/40 p-2 text-xs">
          <span className="font-medium">Developer response: </span>
          {review.store_response}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Commit** (page shells reference clients built in A10–A11; commit after those typecheck. For now just stage the review card + pages and continue.)

```bash
git add "app/mobile-apps/page.tsx" "app/mobile-apps/[id]/page.tsx" components/mobile-apps/review-card.tsx
git commit -m "feat(mobile-apps): page shells + review card component"
```

---

### Task A10: App grid client + add-app dialog

**Files:**
- Create: `components/mobile-apps/mobile-apps-client.tsx`
- Create: `components/mobile-apps/app-card.tsx`
- Create: `components/mobile-apps/add-app-dialog.tsx`

- [ ] **Step 1: Create the add-app dialog**

Create `components/mobile-apps/add-app-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export function AddAppDialog({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [appleRef, setAppleRef] = useState("");
  const [googleRef, setGoogleRef] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const refs = [appleRef, googleRef].map((s) => s.trim()).filter(Boolean);
    if (refs.length === 0) {
      toast.error("Paste at least one App Store or Play Store URL/ID.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/mobile-apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined, refs }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Failed to add app");
      toast.success(`Added ${json.name}`);
      setOpen(false);
      setAppleRef(""); setGoogleRef(""); setName("");
      onAdded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add app");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add app</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a mobile app</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>App Store URL or ID</Label>
            <Input placeholder="https://apps.apple.com/us/app/id310633997" value={appleRef} onChange={(e) => setAppleRef(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Google Play URL or package</Label>
            <Input placeholder="https://play.google.com/store/apps/details?id=com.whatsapp" value={googleRef} onChange={(e) => setGoogleRef(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Display name (optional)</Label>
            <Input placeholder="Auto-detected if blank" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy}>{busy ? "Adding…" : "Add app"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> Before writing, confirm the exact prop names of `@/components/ui/dialog`, `input`, `label`, `button` by opening one existing usage (e.g. `components/metrics/metric-editor-modal.tsx`). Match its imports exactly — if the project's Dialog uses different subcomponent names, adapt these to match.

- [ ] **Step 2: Create the app card**

Create `components/mobile-apps/app-card.tsx`:

```tsx
"use client";

import Link from "next/link";
import { IconBrandApple, IconBrandGooglePlay, IconStarFilled } from "@tabler/icons-react";

export type AppListing = {
  id: string;
  store: string;
  storeAppId: string;
  country: string;
  currentRating: number | null;
  ratingsCount: number | null;
  lastSyncedAt: string | null;
};

export type AppSummary = {
  id: string;
  name: string;
  icon_url: string | null;
  notes: string | null;
  listings: AppListing[];
};

function StoreBadge({ listing }: { listing: AppListing }) {
  const Icon = listing.store === "apple" ? IconBrandApple : IconBrandGooglePlay;
  return (
    <div className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
      <Icon className="size-3.5" />
      <IconStarFilled className="size-3 text-amber-500" />
      <span className="font-medium">{listing.currentRating?.toFixed(2) ?? "—"}</span>
      <span className="text-muted-foreground">
        ({listing.ratingsCount?.toLocaleString() ?? "—"})
      </span>
    </div>
  );
}

export function AppCard({ app }: { app: AppSummary }) {
  return (
    <Link
      href={`/mobile-apps/${app.id}`}
      className="block rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40"
    >
      <div className="flex items-center gap-3">
        {app.icon_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={app.icon_url} alt="" className="size-12 rounded-lg" />
        ) : (
          <div className="size-12 rounded-lg bg-muted" />
        )}
        <div className="min-w-0">
          <div className="truncate font-semibold">{app.name}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {app.listings.map((l) => (
              <StoreBadge key={l.id} listing={l} />
            ))}
          </div>
        </div>
      </div>
    </Link>
  );
}
```

- [ ] **Step 3: Create the grid client**

Create `components/mobile-apps/mobile-apps-client.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { AddAppDialog } from "@/components/mobile-apps/add-app-dialog";
import { AppCard, type AppSummary } from "@/components/mobile-apps/app-card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function MobileAppsClient() {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/mobile-apps", { cache: "no-store" });
    const json = await res.json();
    if (json.ok) setApps(json.apps as AppSummary[]);
    setLoading(false);
  }, []);

  // Stale-while-revalidate: show cached rows, then trigger a live sync.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Fire a non-forced background sync of all apps on mount, then reload.
    (async () => {
      await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }).catch(() => null);
      await load();
    })();
  }, [load]);

  async function refreshAll() {
    setSyncing(true);
    try {
      await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      await load();
      toast.success("Synced");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 overflow-auto p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Mobile Applications</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={refreshAll} disabled={syncing}>
            {syncing ? "Syncing…" : "Refresh now"}
          </Button>
          <AddAppDialog onAdded={load} />
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : apps.length === 0 ? (
        <p className="text-sm text-muted-foreground">No apps yet. Add one to start tracking reviews and ratings.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((a) => (
            <AppCard key={a.id} app={a} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If any `@/components/ui/*` import path/prop differs, fix to match the existing component's real API.)

- [ ] **Step 5: Commit**

```bash
git add components/mobile-apps/mobile-apps-client.tsx components/mobile-apps/app-card.tsx components/mobile-apps/add-app-dialog.tsx
git commit -m "feat(mobile-apps): app grid client, app card, add-app dialog"
```

---

### Task A11: App detail client (ratings chart + histogram + reviews feed)

**Files:**
- Create: `components/mobile-apps/app-detail-client.tsx`

- [ ] **Step 1: Inspect the reusable chart component**

Open `components/metrics/metric-chart.tsx` and note its exported component name and props (it wraps recharts). The detail client will render a simple line chart of `avg_rating` over `captured_at`. If `metric-chart.tsx` exports a generic chart you can feed `{ x, series }`, reuse it; otherwise use recharts directly (already a dependency) as shown below.

- [ ] **Step 2: Create the detail client**

Create `components/mobile-apps/app-detail-client.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Button } from "@/components/ui/button";
import { ReviewCard, type ReviewRow } from "@/components/mobile-apps/review-card";
import { toast } from "sonner";

type Listing = {
  id: string;
  store: string;
  current_rating: number | null;
  ratings_count: number | null;
  last_synced_at: string | null;
};
type Snapshot = {
  listing_id: string;
  store: string;
  captured_at: string;
  avg_rating: number | null;
  ratings_count: number | null;
  histogram: Record<string, number> | null;
};

export function AppDetailClient({ appId }: { appId: string }) {
  const [app, setApp] = useState<{ id: string; name: string; icon_url: string | null } | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [store, setStore] = useState<"" | "apple" | "google">("");
  const [minRating, setMinRating] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (store) params.set("store", store);
    if (minRating) params.set("minRating", String(minRating));
    const res = await fetch(`/api/mobile-apps/${appId}?${params.toString()}`, { cache: "no-store" });
    const json = await res.json();
    if (json.ok) {
      setApp(json.app);
      setListings(json.listings);
      setReviews(json.reviews);
      setSnapshots(json.snapshots);
    }
  }, [appId, store, minRating]);

  useEffect(() => {
    void load();
  }, [load]);

  // Stale-while-revalidate: live sync this app on mount.
  useEffect(() => {
    (async () => {
      await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId }),
      }).catch(() => null);
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  async function refresh() {
    setSyncing(true);
    try {
      await fetch("/api/mobile-apps/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appId, force: true }),
      });
      await load();
      toast.success("Synced");
    } finally {
      setSyncing(false);
    }
  }

  // Build chart series: one point per snapshot captured_at, avg_rating.
  const chartData = useMemo(() => {
    return snapshots
      .filter((s) => !store || s.store === store)
      .map((s) => ({
        t: new Date(s.captured_at).toLocaleDateString(),
        rating: s.avg_rating ? Number(s.avg_rating) : null,
        store: s.store,
      }));
  }, [snapshots, store]);

  // Latest histogram for the selected (or first) store.
  const histogram = useMemo(() => {
    const filtered = snapshots.filter((s) => (!store || s.store === store) && s.histogram);
    const latest = filtered[filtered.length - 1];
    return latest?.histogram ?? null;
  }, [snapshots, store]);

  return (
    <div className="flex flex-col gap-4 overflow-auto p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {app?.icon_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={app.icon_url} alt="" className="size-10 rounded-lg" />
          ) : null}
          <h1 className="text-xl font-semibold">{app?.name ?? "App"}</h1>
        </div>
        <Button variant="outline" onClick={refresh} disabled={syncing}>
          {syncing ? "Syncing…" : "Refresh now"}
        </Button>
      </div>

      {/* Store + rating filter toolbar */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select className="rounded-md border bg-background px-2 py-1" value={store} onChange={(e) => setStore(e.target.value as "" | "apple" | "google")}>
          <option value="">All stores</option>
          <option value="apple">App Store</option>
          <option value="google">Google Play</option>
        </select>
        <select className="rounded-md border bg-background px-2 py-1" value={minRating} onChange={(e) => setMinRating(Number(e.target.value))}>
          <option value={0}>Any rating</option>
          <option value={1}>★ 1+</option>
          <option value={2}>★ 2+</option>
          <option value={3}>★ 3+</option>
          <option value={4}>★ 4+</option>
          <option value={5}>★ 5 only</option>
        </select>
        {listings.map((l) => (
          <span key={l.id} className="rounded-md border px-2 py-1 text-xs capitalize">
            {l.store}: {l.current_rating?.toFixed(2) ?? "—"} ({l.ratings_count?.toLocaleString() ?? "—"})
          </span>
        ))}
      </div>

      {/* Ratings over time */}
      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">Rating over time</h2>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="t" fontSize={11} />
              <YAxis domain={[0, 5]} fontSize={11} />
              <Tooltip />
              <Line type="monotone" dataKey="rating" stroke="var(--primary)" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Histogram */}
      {histogram ? (
        <div className="rounded-xl border bg-card p-4">
          <h2 className="mb-2 text-sm font-medium">Star distribution</h2>
          <div className="space-y-1">
            {[5, 4, 3, 2, 1].map((star) => {
              const total = Object.values(histogram).reduce((a, b) => a + Number(b), 0) || 1;
              const v = Number(histogram[String(star)] ?? 0);
              return (
                <div key={star} className="flex items-center gap-2 text-xs">
                  <span className="w-6">{star}★</span>
                  <div className="h-2 flex-1 rounded bg-muted">
                    <div className="h-2 rounded bg-amber-500" style={{ width: `${(v / total) * 100}%` }} />
                  </div>
                  <span className="w-12 text-right text-muted-foreground">{v.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Reviews feed */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Reviews ({reviews.length})</h2>
        {reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reviews match the current filters.</p>
        ) : (
          reviews.map((r) => <ReviewCard key={r.id} review={r} />)
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: no errors. Fix any `@/components/ui/*` import mismatches against the real components.

- [ ] **Step 4: Manual verification**

Dev server running, module enabled, with the app added in A7: navigate to `/mobile-apps`, see the app card; click it; see the rating-over-time chart (will have ≥1 point after the first sync), histogram (Google), and the reviews feed. Click **Refresh now** and confirm new reviews/snapshot appear.

- [ ] **Step 5: Commit**

```bash
git add components/mobile-apps/app-detail-client.tsx
git commit -m "feat(mobile-apps): app detail client with ratings chart, histogram, reviews feed"
```

---

### Task A12: Phase A production build gate

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: build succeeds with no type or lint errors across the new files.

- [ ] **Step 2: Commit any fixups**

```bash
git add -A
git commit -m "chore(mobile-apps): Phase A build green"
```

**✅ Phase A checkpoint:** The module is fully usable for viewing live reviews + ratings. Stop here for review before Phase B.

---

# PHASE B — Live updates (SSE) + agent sentiment digest

---

### Task B1: SSE stream for `mobile_apps_change`

**Files:**
- Create: `app/api/mobile-apps/stream/route.ts`
- Modify: `components/mobile-apps/app-detail-client.tsx` (subscribe)

- [ ] **Step 1: Create the SSE route**

Create `app/api/mobile-apps/stream/route.ts` (modeled on `app/api/notifications/stream/route.ts`):

```ts
import { getSql } from "@/lib/local-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const sql = getSql();
  const encoder = new TextEncoder();
  const { signal } = request;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unlisten: (() => Promise<void>) | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (unlisten) unlisten().catch(() => {});
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const send = (event: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          cleanup();
        }
      };

      const heartbeat = setInterval(() => send("ping", "keepalive"), 25_000);
      signal.addEventListener("abort", cleanup, { once: true });
      send("connected", JSON.stringify({ ts: Date.now() }));

      try {
        const meta = await sql.listen("mobile_apps_change", (payload: string) => {
          send("change", String(payload || "{}"));
        });
        unlisten = () => meta.unlisten();
      } catch {
        /* graceful degradation */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 2: Subscribe in the detail client**

In `components/mobile-apps/app-detail-client.tsx`, add this effect after the existing sync effect (it re-loads when this app changes):

```tsx
  useEffect(() => {
    const es = new EventSource("/api/mobile-apps/stream");
    es.addEventListener("change", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data || "{}");
        if (!data.appId || data.appId === appId) void load();
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [appId, load]);
```

- [ ] **Step 3: Typecheck + manual check**

Run: `npx tsc --noEmit` (expect no errors). With two browser tabs on the same app detail, click **Refresh now** in one; the other updates without manual reload.

- [ ] **Step 4: Commit**

```bash
git add app/api/mobile-apps/stream/route.ts components/mobile-apps/app-detail-client.tsx
git commit -m "feat(mobile-apps): SSE live updates on mobile_apps_change"
```

---

### Task B2: Digest engine (build prompt + dispatch agent + parse)

**Files:**
- Create: `lib/mobile-apps/digest.ts`

- [ ] **Step 1: Implement the digest engine**

Create `lib/mobile-apps/digest.ts`. This reuses the synchronous agent-dispatch pattern from `app/api/processes/simulate/route.ts` (`openclaw agent --json --local`, parse `payloads[].text`).

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSql } from "@/lib/local-db";

const execFileAsync = promisify(execFile);

type ReviewForPrompt = {
  store: string;
  rating: number | null;
  title: string | null;
  body: string | null;
  submitted_at: string | null;
};

/** Pure: compose the digest prompt from recent reviews. Exported for testing. */
export function buildDigestPrompt(appName: string, reviews: ReviewForPrompt[]): string {
  const lines = reviews
    .slice(0, 100)
    .map((r) => `- [${r.store}] ${r.rating ?? "?"}★ ${r.title ? r.title + ": " : ""}${(r.body || "").replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return [
    `You are analyzing recent app store reviews for "${appName}".`,
    `Write a concise sentiment digest in Markdown with these sections:`,
    `## Overall sentiment (one line + an approximate score from -1.0 to 1.0)`,
    `## Top complaints (bulleted, most frequent first)`,
    `## Top praise (bulleted)`,
    `## Notable themes (comma-separated tags)`,
    ``,
    `Base it ONLY on these reviews. Do not invent issues not present.`,
    ``,
    `Reviews:`,
    lines || "(no recent reviews)",
  ].join("\n");
}

/** Run an agent turn locally and return its text output. */
async function dispatchAgent(agentId: string, message: string, timeoutMs = 120_000): Promise<string> {
  const cleanEnv = { ...process.env };
  delete cleanEnv.OPENCLAW_GATEWAY_URL;
  delete cleanEnv.OPENCLAW_GATEWAY_TOKEN;
  const { stdout, stderr } = await execFileAsync(
    "openclaw",
    ["agent", "--agent", agentId, "--message", message, "--json", "--local"],
    { timeout: timeoutMs, env: cleanEnv, maxBuffer: 50 * 1024 * 1024 },
  );
  const raw = (stdout || "").trim() ? stdout : stderr || "";
  const parsed = JSON.parse(raw);
  const payloads = parsed?.result?.payloads ?? parsed?.payloads ?? [];
  return (
    payloads.map((p: { text?: string }) => p.text ?? "").join("\n").trim() || JSON.stringify(parsed)
  );
}

/** Generate + persist a digest for an app. Returns the new digest row id. */
export async function generateDigest(appId: string, agentId = "main"): Promise<string> {
  const sql = getSql();
  const appRows = (await sql`select name from mobile_apps where id = ${appId} limit 1`) as unknown as Array<{ name: string }>;
  if (!appRows[0]) throw new Error("App not found");

  const reviews = (await sql`
    select l.store, r.rating, r.title, r.body, r.submitted_at
    from app_reviews r
    join mobile_app_listings l on l.id = r.listing_id
    where l.mobile_app_id = ${appId}
    order by r.submitted_at desc nulls last
    limit 100
  `) as unknown as ReviewForPrompt[];

  const prompt = buildDigestPrompt(appRows[0].name, reviews);
  const summaryMd = await dispatchAgent(agentId, prompt);

  const periodEnd = reviews[0]?.submitted_at ?? null;
  const periodStart = reviews[reviews.length - 1]?.submitted_at ?? null;

  const ins = (await sql`
    insert into app_review_digests (mobile_app_id, period_start, period_end, summary_md, generated_by_agent_id)
    values (${appId}, ${periodStart}, ${periodEnd}, ${summaryMd}, ${agentId})
    returning id::text
  `) as unknown as Array<{ id: string }>;
  return ins[0].id;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/mobile-apps/digest.ts
git commit -m "feat(mobile-apps): agent sentiment digest engine"
```

---

### Task B3: Digest route + UI panel

**Files:**
- Create: `app/api/mobile-apps/[id]/digest/route.ts`
- Modify: `components/mobile-apps/app-detail-client.tsx` (digest panel)

- [ ] **Step 1: Create the digest route**

Create `app/api/mobile-apps/[id]/digest/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { generateDigest } from "@/lib/mobile-apps/digest";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled.", 503);
    const { id } = await ctx.params;
    const sql = getSql();
    const digests = await sql`
      select id::text, period_start, period_end, summary_md, sentiment_score, top_themes, generated_by_agent_id, created_at
      from app_review_digests
      where mobile_app_id = ${id}
      order by created_at desc
      limit 20
    `;
    return ok({ digests });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load digests", 500);
  }
}

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled.", 503);
    const { id } = await ctx.params;
    const digestId = await generateDigest(id);
    return ok({ id: digestId });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to generate digest", 500);
  }
}
```

- [ ] **Step 2: Add the digest panel to the detail client**

In `components/mobile-apps/app-detail-client.tsx`, add state + loader + a panel. Add near the other state:

```tsx
  const [digest, setDigest] = useState<{ summary_md: string; created_at: string } | null>(null);
  const [genBusy, setGenBusy] = useState(false);

  const loadDigest = useCallback(async () => {
    const res = await fetch(`/api/mobile-apps/${appId}/digest`, { cache: "no-store" });
    const json = await res.json();
    if (json.ok && json.digests?.[0]) setDigest(json.digests[0]);
  }, [appId]);

  useEffect(() => {
    void loadDigest();
  }, [loadDigest]);

  async function generate() {
    setGenBusy(true);
    try {
      const res = await fetch(`/api/mobile-apps/${appId}/digest`, { method: "POST" });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Failed");
      await loadDigest();
      toast.success("Digest generated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to generate digest");
    } finally {
      setGenBusy(false);
    }
  }
```

And render this panel just above the reviews feed section:

```tsx
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Sentiment digest</h2>
          <Button size="sm" variant="outline" onClick={generate} disabled={genBusy}>
            {genBusy ? "Generating…" : "Generate digest now"}
          </Button>
        </div>
        {digest ? (
          <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-muted-foreground">
            {digest.summary_md}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No digest yet. Generate one from the latest reviews.</p>
        )}
      </div>
```

> If the project already has a Markdown renderer (check the activity feed / `components/dashboard/activity-logs.tsx` for one), use it here instead of `whitespace-pre-wrap` for nicer formatting. Match whatever renderer the Documents/activity surfaces use.

- [ ] **Step 3: Typecheck + manual check**

Run: `npx tsc --noEmit` (expect no errors). On an app with reviews, click **Generate digest now**; after the agent runs, the markdown digest appears. (Requires the `openclaw` CLI available in the server's PATH, same as Processes simulation.)

- [ ] **Step 4: Commit**

```bash
git add "app/api/mobile-apps/[id]/digest/route.ts" components/mobile-apps/app-detail-client.tsx
git commit -m "feat(mobile-apps): on-demand agent sentiment digest route + panel"
```

---

# PHASE C — Threshold alerts

---

### Task C1: Alert evaluation (pure, tested) + fan-out

**Files:**
- Create: `lib/mobile-apps/alerts.ts`
- Test: `scripts/mobile-apps/alerts.test.mjs`

- [ ] **Step 1: Write the failing evaluation test**

Create `scripts/mobile-apps/alerts.test.mjs`:

```js
import assert from "node:assert/strict";
import { evaluateRule } from "../../lib/mobile-apps/alerts.ts";

// avg_rating below threshold → trips
assert.equal(
  evaluateRule(
    { metric: "avg_rating", operator: "lt", threshold: 4.0 },
    { avgRating: 3.8, oneStarToday: 0, reviewsToday: 5 },
  ),
  true,
);
// avg_rating at/above threshold → no trip
assert.equal(
  evaluateRule(
    { metric: "avg_rating", operator: "lt", threshold: 4.0 },
    { avgRating: 4.2, oneStarToday: 0, reviewsToday: 5 },
  ),
  false,
);
// one_star_spike gt threshold → trips
assert.equal(
  evaluateRule(
    { metric: "one_star_spike", operator: "gt", threshold: 3 },
    { avgRating: 4.5, oneStarToday: 7, reviewsToday: 20 },
  ),
  true,
);
// review_volume gt threshold → trips
assert.equal(
  evaluateRule(
    { metric: "review_volume", operator: "gt", threshold: 50 },
    { avgRating: 4.5, oneStarToday: 1, reviewsToday: 60 },
  ),
  true,
);
// null metric value never trips
assert.equal(
  evaluateRule(
    { metric: "avg_rating", operator: "lt", threshold: 4.0 },
    { avgRating: null, oneStarToday: 0, reviewsToday: 0 },
  ),
  false,
);

console.log("ok - evaluateRule");
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --experimental-strip-types scripts/mobile-apps/alerts.test.mjs`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement alerts**

Create `lib/mobile-apps/alerts.ts`:

```ts
import { getSql } from "@/lib/local-db";

export type AlertMetric = "avg_rating" | "one_star_spike" | "review_volume";
export type AlertOperator = "lt" | "lte" | "gt" | "gte" | "eq";

export type AlertRule = {
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
};

export type AppAlertSignals = {
  avgRating: number | null;
  oneStarToday: number;
  reviewsToday: number;
};

/** Pure: does this rule trip given the current signals? */
export function evaluateRule(rule: AlertRule, signals: AppAlertSignals): boolean {
  const value =
    rule.metric === "avg_rating"
      ? signals.avgRating
      : rule.metric === "one_star_spike"
        ? signals.oneStarToday
        : signals.reviewsToday;
  if (value == null || !Number.isFinite(value)) return false;
  switch (rule.operator) {
    case "lt": return value < rule.threshold;
    case "lte": return value <= rule.threshold;
    case "gt": return value > rule.threshold;
    case "gte": return value >= rule.threshold;
    case "eq": return value === rule.threshold;
  }
}

type Sql = ReturnType<typeof getSql>;

/** Compute current alert signals for an app from listings + today's reviews. */
export async function computeSignals(sql: Sql, appId: string): Promise<AppAlertSignals> {
  const ratingRows = (await sql`
    select avg(current_rating)::numeric(3,2) as avg
    from mobile_app_listings where mobile_app_id = ${appId} and current_rating is not null
  `) as unknown as Array<{ avg: number | null }>;
  const todayRows = (await sql`
    select
      count(*) filter (where r.rating = 1)::int as one_star,
      count(*)::int as total
    from app_reviews r
    join mobile_app_listings l on l.id = r.listing_id
    where l.mobile_app_id = ${appId}
      and r.submitted_at >= date_trunc('day', now())
  `) as unknown as Array<{ one_star: number; total: number }>;
  return {
    avgRating: ratingRows[0]?.avg ?? null,
    oneStarToday: todayRows[0]?.one_star ?? 0,
    reviewsToday: todayRows[0]?.total ?? 0,
  };
}

/**
 * Evaluate all enabled rules for an app after a sync; fire notifications via
 * notification_channels for any that trip (debounced: not refired within 6h).
 */
export async function evaluateAndFire(appId: string): Promise<void> {
  const sql = getSql();
  const rules = (await sql`
    select id::text, metric, operator, threshold::float8 as threshold, channel_ids, last_fired_at
    from app_alert_rules
    where enabled = true and (mobile_app_id = ${appId} or mobile_app_id is null)
  `) as unknown as Array<{
    id: string; metric: AlertMetric; operator: AlertOperator; threshold: number;
    channel_ids: string[]; last_fired_at: string | null;
  }>;
  if (rules.length === 0) return;

  const signals = await computeSignals(sql, appId);
  const appRows = (await sql`select name from mobile_apps where id = ${appId} limit 1`) as unknown as Array<{ name: string }>;
  const appName = appRows[0]?.name ?? "App";

  for (const rule of rules) {
    const trips = evaluateRule(rule, signals);
    if (!trips) continue;
    const recentlyFired = rule.last_fired_at && Date.now() - new Date(rule.last_fired_at).getTime() < 6 * 60 * 60 * 1000;
    if (recentlyFired) continue;

    const message = `📱 ${appName}: alert "${rule.metric} ${rule.operator} ${rule.threshold}" tripped (avg ${signals.avgRating ?? "?"}, 1★ today ${signals.oneStarToday}, reviews today ${signals.reviewsToday}).`;
    await notifyChannels(sql, rule.channel_ids, message).catch(() => null);
    await sql`update app_alert_rules set last_fired_at = now() where id = ${rule.id}`.catch(() => null);
  }
}

/**
 * Deliver a message to the given notification_channels rows. This logs to
 * activity_logs as a guaranteed sink; channel-specific delivery (Telegram/Slack)
 * reuses whatever the existing notifications system exposes.
 */
async function notifyChannels(sql: Sql, channelIds: string[], message: string): Promise<void> {
  const wid = (await sql`select id from workspaces order by created_at asc limit 1`) as unknown as Array<{ id: string }>;
  const workspaceId = wid[0]?.id;
  if (workspaceId) {
    await sql`
      insert into activity_logs (workspace_id, source, event, details, level)
      values (${workspaceId}, 'Mobile Applications', 'alert', ${message}, 'warning')
    `.catch(() => null);
  }
  // TODO-INTEGRATION (not a placeholder for this plan): if channelIds reference
  // notification_channels with provider telegram/slack, deliver via the same
  // helper bridge-logger uses for agenda alerts. Wiring that helper is Task C3.
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --experimental-strip-types scripts/mobile-apps/alerts.test.mjs`
Expected: `ok - evaluateRule`

- [ ] **Step 5: Commit**

```bash
git add lib/mobile-apps/alerts.ts scripts/mobile-apps/alerts.test.mjs
git commit -m "feat(mobile-apps): tested alert evaluation + activity-log fan-out"
```

---

### Task C2: Wire alert evaluation into sync + alert CRUD route

**Files:**
- Modify: `lib/mobile-apps/sync.ts` (call `evaluateAndFire` after a successful sync)
- Create: `app/api/mobile-apps/alerts/route.ts`

- [ ] **Step 1: Call alerts at the end of sync**

In `lib/mobile-apps/sync.ts`, import at the top:

```ts
import { evaluateAndFire } from "@/lib/mobile-apps/alerts";
```

and just before the final `pg_notify` line in `syncApp`, add:

```ts
  await evaluateAndFire(appId).catch(() => null);
```

- [ ] **Step 2: Create the alert CRUD route**

Create `app/api/mobile-apps/alerts/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

const VALID_METRICS = new Set(["avg_rating", "one_star_spike", "review_volume"]);
const VALID_OPS = new Set(["lt", "lte", "gt", "gte", "eq"]);

export async function GET() {
  const session = await getSession();
  if (!session?.email) return fail("Not authenticated", 401);
  if (!(await isModuleEnabled("mobile-apps"))) return fail("Module disabled", 503);
  const sql = getSql();
  const rules = await sql`
    select id::text, mobile_app_id::text, metric, operator, threshold::float8 as threshold,
           window, channel_ids, enabled, last_fired_at
    from app_alert_rules order by created_at asc
  `;
  return ok({ rules });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.email) return fail("Not authenticated", 401);
  if (!(await isModuleEnabled("mobile-apps"))) return fail("Module disabled", 503);
  const body = (await request.json()) as {
    mobileAppId?: string | null; metric?: string; operator?: string;
    threshold?: number; window?: string; channelIds?: string[];
  };
  if (!VALID_METRICS.has(String(body.metric))) return fail("Invalid metric");
  if (!VALID_OPS.has(String(body.operator))) return fail("Invalid operator");
  if (typeof body.threshold !== "number") return fail("threshold must be a number");
  const sql = getSql();
  const rows = (await sql`
    insert into app_alert_rules (mobile_app_id, metric, operator, threshold, window, channel_ids)
    values (
      ${body.mobileAppId ?? null}, ${body.metric}, ${body.operator}, ${body.threshold},
      ${body.window ?? "daily"}, ${sql.array(body.channelIds ?? [])}
    )
    returning id::text
  `) as unknown as Array<{ id: string }>;
  return ok({ id: rows[0].id });
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session?.email) return fail("Not authenticated", 401);
  if (!(await isModuleEnabled("mobile-apps"))) return fail("Module disabled", 503);
  const body = (await request.json()) as { id?: string; enabled?: boolean; threshold?: number };
  const id = String(body.id || "");
  if (!id) return fail("id required");
  const sql = getSql();
  if (typeof body.enabled === "boolean") {
    await sql`update app_alert_rules set enabled = ${body.enabled} where id = ${id}`;
  }
  if (typeof body.threshold === "number") {
    await sql`update app_alert_rules set threshold = ${body.threshold} where id = ${id}`;
  }
  return ok();
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session?.email) return fail("Not authenticated", 401);
  if (!(await isModuleEnabled("mobile-apps"))) return fail("Module disabled", 503);
  const body = (await request.json()) as { id?: string };
  const id = String(body.id || "");
  if (!id) return fail("id required");
  const sql = getSql();
  await sql`delete from app_alert_rules where id = ${id}`;
  return ok();
}
```

- [ ] **Step 3: Typecheck + smoke**

Run: `npx tsc --noEmit` (expect no errors), then:

```bash
curl -s -u "$API_USER:$API_PASS" -X POST http://localhost:3000/api/mobile-apps/alerts \
  -H 'content-type: application/json' \
  -d '{"metric":"avg_rating","operator":"lt","threshold":4.0}'
```

Expected: `{"ok":true,"id":"<uuid>"}`. Trigger a sync (`POST /api/mobile-apps/sync {force:true}`) on an app whose avg < 4.0 and confirm an `activity_logs` row with source `Mobile Applications`, event `alert` appears (visible in the Dashboard activity feed).

- [ ] **Step 4: Commit**

```bash
git add lib/mobile-apps/sync.ts app/api/mobile-apps/alerts/route.ts
git commit -m "feat(mobile-apps): evaluate alerts on sync + alert-rule CRUD route"
```

---

### Task C3: Alerts UI panel + channel delivery wiring

**Files:**
- Modify: `components/mobile-apps/app-detail-client.tsx` (alerts panel)
- Modify: `lib/mobile-apps/alerts.ts` (deliver to Telegram/Slack channels)

- [ ] **Step 1: Find the existing notification delivery helper**

Search for how agenda failures notify Telegram (the README mentions bridge-logger sends Telegram alerts). Run a grep for the helper and the `notification_channels` read:

Run: `git grep -n "notification_channels\|sendTelegram\|notifyChannel" -- "*.ts" "*.mjs"`
Expected: locate the helper that posts to a channel. If a reusable server helper exists (e.g. `lib/notifications/*`), import it; otherwise deliver via the channel's stored webhook/token directly. Document which you used in the commit message.

- [ ] **Step 2: Implement channel delivery**

Replace the `TODO-INTEGRATION` comment block in `lib/mobile-apps/alerts.ts`'s `notifyChannels` with real delivery using whatever helper Step 1 found. Concretely, fetch the channels and dispatch:

```ts
  if (channelIds.length === 0) return;
  const channels = (await sql`
    select provider, target, enabled from notification_channels
    where id = any(${sql.array(channelIds)}) and enabled = true
  `) as unknown as Array<{ provider: string; target: string }>;
  for (const ch of channels) {
    // Reuse the helper located in Step 1. Example shape:
    // await deliverNotification({ provider: ch.provider, target: ch.target, text: message });
  }
```

Fill the loop body with the actual helper call discovered in Step 1.

- [ ] **Step 3: Add the alerts panel to the detail client**

In `components/mobile-apps/app-detail-client.tsx`, add a minimal alerts panel below the digest panel:

```tsx
  const [rules, setRules] = useState<Array<{ id: string; metric: string; operator: string; threshold: number; enabled: boolean }>>([]);
  const [newThreshold, setNewThreshold] = useState(4.0);

  const loadRules = useCallback(async () => {
    const res = await fetch("/api/mobile-apps/alerts", { cache: "no-store" });
    const json = await res.json();
    if (json.ok) setRules(json.rules);
  }, []);
  useEffect(() => { void loadRules(); }, [loadRules]);

  async function addRule() {
    await fetch("/api/mobile-apps/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mobileAppId: appId, metric: "avg_rating", operator: "lt", threshold: newThreshold }),
    });
    await loadRules();
    toast.success("Alert added");
  }
  async function deleteRule(id: string) {
    await fetch("/api/mobile-apps/alerts", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
    });
    await loadRules();
  }
```

Render:

```tsx
      <div className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">Alerts</h2>
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span>Notify when average rating drops below</span>
          <input
            type="number" step="0.1" min={0} max={5}
            className="w-20 rounded-md border bg-background px-2 py-1"
            value={newThreshold}
            onChange={(e) => setNewThreshold(Number(e.target.value))}
          />
          <Button size="sm" variant="outline" onClick={addRule}>Add alert</Button>
        </div>
        <ul className="space-y-1 text-sm">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center justify-between rounded border px-2 py-1">
              <span>{r.metric} {r.operator} {r.threshold} {r.enabled ? "" : "(disabled)"}</span>
              <Button size="sm" variant="ghost" onClick={() => deleteRule(r.id)}>Remove</Button>
            </li>
          ))}
        </ul>
      </div>
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit` then `npm run build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add components/mobile-apps/app-detail-client.tsx lib/mobile-apps/alerts.ts
git commit -m "feat(mobile-apps): alerts UI panel + channel delivery wiring"
```

---

### Task C4: Docs + final build gate

**Files:**
- Modify: `README.md` (add a "Mobile Applications" section near the Metrics blurb)

- [ ] **Step 1: Document the module**

Add a short README section describing the module: what it does, that v1 uses free public sources (Apple RSS + iTunes Lookup, `google-play-scraper`), real-time on page-load sync, on-demand digests (needs `openclaw` CLI on the server PATH), alerts checked on each sync, and the `npm install` note for `google-play-scraper`. Mirror the tone of the existing Metrics paragraph.

- [ ] **Step 2: Run all pure-logic tests**

Run:
```
node --experimental-strip-types scripts/mobile-apps/resolve.test.mjs
node --experimental-strip-types scripts/mobile-apps/apple-parse.test.mjs
node --experimental-strip-types scripts/mobile-apps/google-map.test.mjs
node --experimental-strip-types scripts/mobile-apps/alerts.test.mjs
```
Expected: four `ok - ...` lines, no throws.

- [ ] **Step 3: Final production build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(mobile-apps): document the Mobile Applications module"
```

---

## Self-Review (completed during planning)

**Spec coverage:**
- Toggleable module named "Mobile Applications" → Task A1/A2. ✅
- Both stores, free public sources behind a provider interface → A4 (Apple), A5 (Google), A5 `getProvider`. ✅
- Real-time on-page-load sync + Refresh now + stale-while-revalidate + de-dupe guard → A6 (engine, `force`/`dedupeMs`), A10/A11 (client). ✅
- One app spans both stores → A2 schema (`mobile_app_listings` unique per `(mobile_app_id, store)`), A7 add-app accepts both refs. ✅
- Reviews feed (filter by store/rating) + ratings chart + histogram → A8 (filters), A11 (UI). ✅
- Rating snapshots per sync → A6. ✅
- On-demand agent digest → B2/B3. ✅
- Threshold alerts evaluated on each sync + channels → C1/C2/C3. ✅
- SSE live updates (`mobile_apps_change`) → A6 (notify), B1 (stream). ✅
- Settings toggle + cleanup → A1/A2 (registry tables + handler). ✅
- `google-play-scraper` dependency → A5. ✅
- Out-of-scope items (replies, scheduled alerts, ASO/rank, crash stats) intentionally omitted. ✅

**Placeholder scan:** The only `TODO-INTEGRATION` marker (C1) is explicitly resolved in C3 Steps 1–2 with a concrete discovery + wiring step; it is not left dangling. No "TBD"/"handle edge cases"/"similar to Task N" placeholders elsewhere; all code steps include complete code.

**Type consistency:** `RawReview`/`RatingSummary`/`ListingRef`/`ReviewProvider` defined in A3 are used unchanged in A4/A5/A6. `getProvider(store)` (A5) used by A6/A7. `evaluateRule`/`AppAlertSignals` (C1) used by C2 via `evaluateAndFire`. `syncApp(appId, {force})` signature consistent across A6/A7/A10/A11/C2. `pg_notify('mobile_apps_change', {appId})` (A6) matches the `change` listener (B1) and client filter (B1 Step 2).

**Note for the implementer:** Confirm `@/components/ui/{dialog,input,label,button}` exact export/prop names against an existing usage (e.g. `components/metrics/metric-editor-modal.tsx`) before writing A10/B3/C3 UI — adapt imports to the real components. Confirm the `.ts` test runner (`--experimental-strip-types` vs `npx tsx`) matches what the repo's Node supports.
