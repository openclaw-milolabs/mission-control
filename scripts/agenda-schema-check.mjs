/**
 * Schema assertion for the agenda system.
 * Called on scheduler startup — fails fast if the DB is missing required columns
 * rather than letting the scheduler run silently broken.
 */

async function getTableColumns(sql, tableName) {
  const rows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
  `;
  return new Set(rows.map((r) => r.column_name));
}

// Keep the old export for backward compatibility
export async function getAgendaOccurrenceColumns(sql) {
  return getTableColumns(sql, 'agenda_occurrences');
}

export async function assertAgendaSchema(sql) {
  const errors = [];

  // ── agenda_occurrences ────────────────────────────────────────────────────
  const occCols = await getTableColumns(sql, 'agenda_occurrences');
  const requiredOccurrenceCols = [
    // v1
    'retry_requested_at',
    'latest_attempt_no',
    'last_retry_reason',
    // v2 cron engine
    'cron_job_id',
    'fallback_attempted',
    'cron_synced_at',
    'rendered_prompt',
    // v3 dependencies
    'skip_reason',
  ];
  const missingOcc = requiredOccurrenceCols.filter((c) => !occCols.has(c));
  if (missingOcc.length > 0) {
    errors.push(`agenda_occurrences missing columns: ${missingOcc.join(', ')}`);
  }

  // ── agenda_events ─────────────────────────────────────────────────────────
  // execution_window_minutes is required for the per-event stale-running sweep.
  // session_target is required for the cron job creation.
  const evtCols = await getTableColumns(sql, 'agenda_events');
  const requiredEventCols = [
    'execution_window_minutes',
    'session_target',
    'model_override',
    'depends_on_event_id',
    'dependency_timeout_hours',
    'notify_chat_id',
  ];
  const missingEvt = requiredEventCols.filter((c) => !evtCols.has(c));
  if (missingEvt.length > 0) {
    errors.push(`agenda_events missing columns: ${missingEvt.join(', ')}`);
  }

  // ── agenda_run_attempts ───────────────────────────────────────────────────
  const attemptCols = await getTableColumns(sql, 'agenda_run_attempts');
  // cron_job_id was renamed from queue_job_id in phase 4
  const requiredAttemptCols = ['cron_job_id', 'error_message', 'summary'];
  const missingAttempt = requiredAttemptCols.filter((c) => !attemptCols.has(c));
  if (missingAttempt.length > 0) {
    errors.push(`agenda_run_attempts missing columns: ${missingAttempt.join(', ')}`);
  }

  if (errors.length > 0) {
    throw new Error(`Schema assertion failed:\n  - ${errors.join('\n  - ')}\n\nRun: npm run db:setup  (or docker exec ... psql -f db/schema.sql)`);
  }

  return { ok: true };
}
