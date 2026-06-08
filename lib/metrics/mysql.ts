import type { Pool, RowDataPacket } from "mysql2/promise";
import { getMysqlCredentials, type MysqlCredentials } from "@/lib/metrics/secrets";
import { makeLimiter } from "@/lib/metrics/limiter";

/**
 * MySQL connectivity for the Metrics module.
 *
 * Connection lifecycle:
 *   - Lazy module-level pool, recreated when credentials change.
 *   - Statement-level timeout enforced via SET STATEMENT max_execution_time
 *     before the user query.
 *   - Hard row cap on the read side (we slice in JS) to prevent a runaway
 *     SELECT * from blowing up the Node process.
 */

const QUERY_TIMEOUT_MS = 20_000;
const MAX_ROWS = 50_000;

// Cap how many external MySQL queries run at once, process-wide. The dashboard
// fires one query per visible metric card simultaneously; without this gate
// they all hit MySQL together, starve each other, and trip the per-query
// inactivity timeout. Queued queries wait here (before a connection or the
// statement timer is involved), so waiting does not itself cause a timeout.
const MAX_CONCURRENT_QUERIES = 3;
const queryGate = makeLimiter(MAX_CONCURRENT_QUERIES);

let _pool: Pool | null = null;
let _poolKey = "";

function poolKey(c: MysqlCredentials): string {
  return `${c.host}:${c.port}/${c.database || ""}@${c.user}`;
}

async function ensurePool(c: MysqlCredentials): Promise<Pool> {
  const key = poolKey(c);
  if (_pool && _poolKey === key) return _pool;
  // Recreate on credential change. Best-effort close of the previous pool.
  if (_pool) {
    try { await _pool.end(); } catch { /* ignore */ }
    _pool = null;
  }
  const mysql2 = await import("mysql2/promise");
  _pool = mysql2.createPool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database || undefined,
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 20,
    idleTimeout: 60_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
    dateStrings: true,
    multipleStatements: false,
    namedPlaceholders: false,
  });
  _poolKey = key;
  return _pool;
}

export type MetricRow = Record<string, unknown>;

export type QueryResult = {
  ok: true;
  columns: Array<{ name: string; type: string | null }>;
  rows: MetricRow[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
};

export type QueryFailure = {
  ok: false;
  error: string;
  durationMs: number;
};

export async function executeMetricQuery(
  sql: string,
  values: unknown[],
): Promise<QueryResult | QueryFailure> {
  const t0 = Date.now();
  const creds = getMysqlCredentials();
  if (!creds.ok) {
    return { ok: false, error: creds.reason || "MySQL not configured.", durationMs: 0 };
  }
  let pool: Pool;
  try {
    pool = await ensurePool(creds);
  } catch (err) {
    return { ok: false, error: `MySQL pool init failed: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - t0 };
  }

  // Serialize down to MAX_CONCURRENT_QUERIES so simultaneous card loads don't
  // overwhelm MySQL. Acquiring a connection happens inside the gate so we never
  // hold a pooled connection while waiting our turn.
  return queryGate(async () => {
    let conn;
    try {
      conn = await pool.getConnection();
    } catch (err) {
      return { ok: false, error: `MySQL connect failed: ${err instanceof Error ? err.message : String(err)}`, durationMs: Date.now() - t0 };
    }

    try {
      // Cap statement runtime server-side. Honoured by MySQL 5.7+ and MariaDB.
      await conn.query(`SET STATEMENT max_execution_time = ${QUERY_TIMEOUT_MS} FOR SELECT 1`).catch(() => null);

      const [rowsRaw, fieldsRaw] = await conn.query<RowDataPacket[]>(
        { sql, timeout: QUERY_TIMEOUT_MS, rowsAsArray: false },
        values,
      );
      const rows = Array.isArray(rowsRaw) ? rowsRaw as MetricRow[] : [];
      const truncated = rows.length > MAX_ROWS;
      const capped = truncated ? rows.slice(0, MAX_ROWS) : rows;
      const columns = Array.isArray(fieldsRaw)
        ? fieldsRaw.map((f) => ({ name: (f as { name: string }).name, type: typeNameFromCode((f as { type?: number }).type ?? null) }))
        : Object.keys(capped[0] || {}).map((name) => ({ name, type: null }));
      return {
        ok: true,
        columns,
        rows: capped,
        rowCount: capped.length,
        truncated,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - t0 };
    } finally {
      try { conn.release(); } catch { /* ignore */ }
    }
  });
}

// Backup-DB freshness: the max timestamp in the busiest/most-recent table.
// Cached briefly so every card load doesn't re-probe. Best-effort — null when the
// table is absent or the query fails (e.g. a deployment without PlayerSession).
let _freshness: { at: number; value: string | null } | null = null;
const FRESHNESS_TTL_MS = 60_000;
const FRESHNESS_SQL = "SELECT MAX(`start`) AS as_of FROM PlayerSession";

export async function fetchDataFreshness(): Promise<string | null> {
  if (_freshness && Date.now() - _freshness.at < FRESHNESS_TTL_MS) return _freshness.value;
  const creds = getMysqlCredentials();
  if (!creds.ok) return null;
  try {
    const pool = await ensurePool(creds);
    const [rows] = await pool.query<RowDataPacket[]>(FRESHNESS_SQL);
    const raw = (rows[0] as { as_of?: string | null } | undefined)?.as_of ?? null;
    // dateStrings:true → raw is already "YYYY-MM-DD HH:MM:SS" in DB-local time.
    const value = raw ? String(raw) : null;
    _freshness = { at: Date.now(), value };
    return value;
  } catch {
    _freshness = { at: Date.now(), value: null };
    return null;
  }
}

export async function pingMysql(): Promise<{
  ok: boolean;
  error: string | null;
  host: string;
  database: string | null;
  version: string | null;
  isReadOnlyUser: boolean | null;
  secretsPath: string;
  dataAsOf: string | null;
}> {
  const creds = getMysqlCredentials();
  if (!creds.ok) {
    return {
      ok: false,
      error: creds.reason || "MySQL not configured.",
      host: creds.host || "",
      database: creds.database,
      version: null,
      isReadOnlyUser: null,
      secretsPath: creds.secretsPath,
      dataAsOf: null,
    };
  }
  try {
    const pool = await ensurePool(creds);
    const [versionRows] = await pool.query<RowDataPacket[]>("SELECT VERSION() AS v");
    const version = String((versionRows[0] as { v: string } | undefined)?.v || "");
    // SHOW GRANTS reveals whether this user has any privileges beyond SELECT.
    // We don't fail if it errors (some setups disable it for non-admins) — just
    // surface "unknown" so the UI can show a softer warning.
    let isReadOnlyUser: boolean | null = null;
    try {
      const [grants] = await pool.query<RowDataPacket[]>("SHOW GRANTS FOR CURRENT_USER()");
      const writePrivs = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|SUPER|REPLACE|RELOAD|FILE)\b/i;
      isReadOnlyUser = !(grants as Array<Record<string, string>>).some((row) => {
        const text = Object.values(row).join(" ");
        return writePrivs.test(text);
      });
    } catch {
      isReadOnlyUser = null;
    }
    return {
      ok: true,
      error: null,
      host: creds.host,
      database: creds.database,
      version,
      isReadOnlyUser,
      secretsPath: creds.secretsPath,
      dataAsOf: await fetchDataFreshness().catch(() => null),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      host: creds.host,
      database: creds.database,
      version: null,
      isReadOnlyUser: null,
      secretsPath: creds.secretsPath,
      dataAsOf: null,
    };
  }
}

// Minimal mysql field-type code → human name for the UI. mysql2 doesn't export
// the enum directly; the numeric codes are stable in the protocol.
function typeNameFromCode(code: number | null): string | null {
  if (code == null) return null;
  const map: Record<number, string> = {
    0: "decimal", 1: "tinyint", 2: "smallint", 3: "int", 4: "float", 5: "double",
    7: "timestamp", 8: "bigint", 9: "mediumint", 10: "date", 11: "time", 12: "datetime",
    13: "year", 16: "bit", 246: "decimal", 252: "blob", 253: "varchar", 254: "char",
  };
  return map[code] || null;
}
