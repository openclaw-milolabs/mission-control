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
    await sql`CREATE INDEX IF NOT EXISTS app_alert_rules_app_idx ON app_alert_rules(mobile_app_id)`;
  },
};
