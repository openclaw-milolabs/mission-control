import { getSql } from "@/lib/local-db";

let _ensured = false;

export async function ensureMobileAppsSchema(sql: ReturnType<typeof getSql>): Promise<void> {
  if (_ensured) return;
  // gen_random_uuid() is core in Postgres 13+; pgcrypto provides it on older
  // servers. Best-effort — ignore if the role can't create extensions.
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.catch(() => null);
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
      store text NOT NULL CHECK (store IN ('apple','google')),
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
  // Official per-storefront ratings (Apple iTunes Lookup / Google Play ratings report).
  await sql`ALTER TABLE mobile_app_listings ADD COLUMN IF NOT EXISTS official_ratings jsonb`;
  // Where current_rating came from + how fresh it is (e.g. google_play_console_ratings_report).
  await sql`ALTER TABLE mobile_app_listings ADD COLUMN IF NOT EXISTS rating_source text`;
  await sql`ALTER TABLE mobile_app_listings ADD COLUMN IF NOT EXISTS rating_as_of timestamptz`;
  // Backfill the store CHECK on pre-existing tables — add ONLY if missing, never
  // drop (so a sync can't briefly run against a table with no constraint, and a
  // failed add leaves any existing constraint intact).
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mobile_app_listings_store_check') THEN
        ALTER TABLE mobile_app_listings ADD CONSTRAINT mobile_app_listings_store_check CHECK (store IN ('apple','google'));
      END IF;
    END $$;
  `.catch(() => null);
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
  // Migration: official-API reviews carry a few extra fields. Idempotent adds.
  await sql`ALTER TABLE app_reviews ADD COLUMN IF NOT EXISTS language text`;
  await sql`ALTER TABLE app_reviews ADD COLUMN IF NOT EXISTS device text`;
  await sql`ALTER TABLE app_reviews ADD COLUMN IF NOT EXISTS raw_json jsonb`;
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
  // Migration: add generated_by_agent_id if table was created before this column existed
  await sql`ALTER TABLE app_review_digests ADD COLUMN IF NOT EXISTS generated_by_agent_id text`;
  await sql`
    CREATE TABLE IF NOT EXISTS app_alert_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      mobile_app_id uuid REFERENCES mobile_apps(id) ON DELETE CASCADE,
      metric text NOT NULL,
      operator text NOT NULL DEFAULT 'lt',
      threshold numeric NOT NULL,
      "window" text NOT NULL DEFAULT 'daily',
      channel_ids text[] NOT NULL DEFAULT '{}'::text[],
      enabled boolean NOT NULL DEFAULT true,
      last_fired_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // Per-listing sync run history: powers "last sync status/error per store".
  await sql`
    CREATE TABLE IF NOT EXISTS app_review_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id uuid NOT NULL REFERENCES mobile_app_listings(id) ON DELETE CASCADE,
      store text NOT NULL CHECK (store IN ('apple','google')),
      app_identifier text NOT NULL,
      status text NOT NULL CHECK (status IN ('running','success','failed')),
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      fetched_count integer NOT NULL DEFAULT 0,
      upserted_count integer NOT NULL DEFAULT 0,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS app_review_sync_runs_listing_idx ON app_review_sync_runs(listing_id, started_at desc)`;
  // Play Console report outcome per run (so report failures are visible, not swallowed).
  await sql`ALTER TABLE app_review_sync_runs ADD COLUMN IF NOT EXISTS report_status text`;
  await sql`ALTER TABLE app_review_sync_runs ADD COLUMN IF NOT EXISTS report_warnings jsonb`;
  // Daily metrics from Play Console bulk reports (installs, crashes, ...). One row
  // per listing/report/dimension/date; `metrics` holds the report's numeric columns.
  await sql`
    CREATE TABLE IF NOT EXISTS mobile_app_report_metrics (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id uuid NOT NULL REFERENCES mobile_app_listings(id) ON DELETE CASCADE,
      report text NOT NULL,
      dimension text NOT NULL DEFAULT 'overview',
      dimension_value text NOT NULL DEFAULT '',
      metric_date date NOT NULL,
      report_month text,
      metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
      source text,
      captured_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (listing_id, report, dimension, dimension_value, metric_date)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS mobile_app_report_metrics_idx ON mobile_app_report_metrics(listing_id, report, metric_date)`;
  await sql`ALTER TABLE mobile_app_report_metrics ADD COLUMN IF NOT EXISTS report_month text`;
  // Structured text dimensions for multi-dimension reports (traffic source / search term / utm…).
  await sql`ALTER TABLE mobile_app_report_metrics ADD COLUMN IF NOT EXISTS dimensions jsonb`;

  // Cache/index of Google Play Console CSV files we have already downloaded and parsed.
  // The raw CSV is not stored; this only prevents re-downloading unchanged reports.
  await sql`
    CREATE TABLE IF NOT EXISTS mobile_app_report_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id uuid NOT NULL REFERENCES mobile_app_listings(id) ON DELETE CASCADE,
      report text NOT NULL,
      dimension text NOT NULL,
      object_path text NOT NULL,
      yyyy_mm text,
      generation text,
      size_bytes bigint,
      downloaded_at timestamptz,
      parsed_at timestamptz,
      rows_count integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'parsed',
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (listing_id, object_path)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS mobile_app_report_files_listing_idx ON mobile_app_report_files(listing_id, report, yyyy_mm desc)`;
  // Backfill the store CHECK on pre-existing sync_runs tables — add only if missing.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_review_sync_runs_store_check') THEN
        ALTER TABLE app_review_sync_runs ADD CONSTRAINT app_review_sync_runs_store_check CHECK (store IN ('apple','google'));
      END IF;
    END $$;
  `.catch(() => null);
  _ensured = true;
}
