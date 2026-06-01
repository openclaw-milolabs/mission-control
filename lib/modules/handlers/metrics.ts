import type { getSql } from "@/lib/local-db";

type Sql = ReturnType<typeof getSql>;

export const metricsHandler = {
  async preview(sql: Sql) {
    const [metrics, runs] = await Promise.all([
      sql`select count(*)::int as n from metrics`.catch(() => [{ n: 0 }]),
      sql`select count(*)::int as n from metric_runs`.catch(() => [{ n: 0 }]),
    ]);
    const sampleMetrics = await sql`
      select name from metrics order by updated_at desc limit 5
    `.catch(() => []) as Array<{ name: string }>;

    return {
      counts: [
        { icon: "📊", label: "saved metrics", n: Number((metrics as Array<{ n: number }>)[0]?.n ?? 0) },
        { icon: "📝", label: "execution log entries", n: Number((runs as Array<{ n: number }>)[0]?.n ?? 0) },
      ],
      bytesOnDisk: null,
      sampleAffected: sampleMetrics.map((m) => ({ kind: "metric", label: m.name })),
      finalWarning:
        "Disabling Metrics permanently deletes every saved chart definition and its run history. The external MySQL database is untouched.",
    };
  },

  async cleanup(sql: Sql): Promise<void> {
    await sql`DROP TABLE IF EXISTS metric_runs CASCADE`;
    await sql`DROP TABLE IF EXISTS metrics CASCADE`;
  },

  async setup(sql: Sql): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS metrics (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name text NOT NULL,
        description text,
        sql_text text NOT NULL,
        chart_type text NOT NULL DEFAULT 'bar',
        x_column text NOT NULL DEFAULT '',
        y_columns text[] NOT NULL DEFAULT '{}'::text[],
        default_window text NOT NULL DEFAULT 'monthly',
        position integer NOT NULL DEFAULT 0,
        created_by_email text,
        created_by_name text,
        updated_by_email text,
        updated_by_name text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS metrics_workspace_idx ON metrics(workspace_id)`;
    await sql`CREATE INDEX IF NOT EXISTS metrics_position_idx ON metrics(workspace_id, position)`;
    await sql`
      CREATE TABLE IF NOT EXISTS metric_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        metric_id uuid REFERENCES metrics(id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        ran_by_email text,
        ran_by_name text,
        window text NOT NULL DEFAULT 'monthly',
        since timestamptz,
        until timestamptz,
        status text NOT NULL DEFAULT 'success',
        error_message text,
        row_count integer,
        duration_ms integer,
        occurred_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS metric_runs_metric_idx ON metric_runs(metric_id, occurred_at desc)`;
  },
};
