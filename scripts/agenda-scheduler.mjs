#!/usr/bin/env node
/**
 * Agenda Scheduler v3 — cron-based execution engine.
 *
 * Responsibilities (this process only):
 *   1. For each active event, expand RRULE over next 48h → create occurrences
 *   2. For each upcoming occurrence without a cron job → render prompt → openclaw cron add --at
 *   3. Listen for pg_notify('agenda_change') for scheduleFallback signals from bridge-logger
 *      and create a new cron job with the fallback model.
 *
 * Result sync (succeeded/failed/needs_retry) is handled entirely by bridge-logger,
 * which watches ~/.openclaw/cron/runs/*.jsonl and writes to DB directly.
 * No polling. No shared state. No race conditions.
 */
import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";
import { assertAgendaSchema } from "./agenda-schema-check.mjs";
import { renderUnifiedTaskMessage } from "./prompt-renderer.mjs";
import { getOccurrenceArtifactDir } from "./runtime-artifacts.mjs";
import { getOpenClawHome } from "./openclaw-config.mjs";
import { callCron } from "./gateway-rpc.mjs";
import {
  transitionOccurrenceToQueued,
  transitionOccurrenceToNeedsRetry,
  transitionStaleRunningToNeedsRetry,
} from "./agenda-domain.mjs";

/**
 * Returns the number of lines in the agent:main:main session file at the
 * moment of calling. This is the injection boundary — bridge-logger uses it
 * to scope output resolution to only the lines written during this task,
 * preventing cross-task contamination in the shared main session.
 * Returns null if the session file cannot be resolved or read.
 */
async function getMainSessionLineOffset() {
  try {
    const sessionsFile = path.join(getOpenClawHome(), "agents", "main", "sessions", "sessions.json");
    const raw = fs.readFileSync(sessionsFile, "utf8");
    const sessions = JSON.parse(raw);
    const mainEntry = sessions["agent:main:main"];
    if (!mainEntry?.sessionFile) return null;
    const content = fs.readFileSync(mainEntry.sessionFile, "utf8");
    const lineCount = content.split("\n").filter((l) => l.trim()).length;
    return lineCount;
  } catch (err) {
    // Log the error so we know why offset capture failed in production.
    console.warn(`[agenda-scheduler] getMainSessionLineOffset: ${err?.message}`);
    return null;
  }
}

/**
 * Emit a structured agenda lifecycle log to agent_logs.
 * Non-fatal — errors are swallowed so log emission never breaks the scheduler.
 */
async function emitSchedulerLog(sql, { workspaceId, agentId, occurrenceId, eventType, level, message, rawPayload = null }) {
  try {
    if (!workspaceId) return;
    // Ensure agent row exists (agent_id is NOT NULL)
    const agentRtId = agentId || "main";
    let [agentRow] = await sql`SELECT id FROM agents WHERE workspace_id = ${workspaceId} AND openclaw_agent_id = ${agentRtId} LIMIT 1`;
    if (!agentRow) {
      [agentRow] = await sql`
        INSERT INTO agents (workspace_id, openclaw_agent_id, status, model)
        VALUES (${workspaceId}, ${agentRtId}, 'idle', null)
        ON CONFLICT (workspace_id, openclaw_agent_id) DO UPDATE SET updated_at = now()
        RETURNING id
      `;
    }
    if (!agentRow?.id) return;
    const preview = String(message || "").slice(0, 240);
    await sql`
      INSERT INTO agent_logs (
        workspace_id, agent_id, runtime_agent_id, occurred_at, level, type,
        message, event_type, direction, channel_type,
        message_preview, is_json, contains_pii, agenda_occurrence_id,
        raw_payload
      ) VALUES (
        ${workspaceId}, ${agentRow.id}, ${agentRtId}, now(), ${level}, 'agenda',
        ${message}, ${eventType}, 'internal', 'internal',
        ${preview}, ${rawPayload != null}, false, ${occurrenceId || null},
        ${rawPayload ? sql.json(rawPayload) : null}
      )
    `;
  } catch (err) {
    console.warn('[agenda-scheduler] emitSchedulerLog failed (non-fatal):', err?.message);
  }
}


const connectionString = process.env.DATABASE_URL?.trim() || process.env.OPENCLAW_DATABASE_URL?.trim();
if (!connectionString) {
  console.error("[agenda-scheduler] Missing DATABASE_URL / OPENCLAW_DATABASE_URL");
  process.exit(1);
}

const SERVICE_NAME = "agenda-scheduler";
const LOOKAHEAD_DAYS = parseInt(process.env.AGENDA_LOOKAHEAD_DAYS || "14", 10);
const SCHEDULER_TICK_MS = Math.max(5_000, parseInt(process.env.AGENDA_SCHEDULER_TICK_MS || "15000", 10));
const SCHEDULER_WAKE_DEBOUNCE_MS = Math.max(250, parseInt(process.env.AGENDA_SCHEDULER_WAKE_DEBOUNCE_MS || "1500", 10));
const sql = postgres(connectionString, { max: 5, prepare: false, idle_timeout: 20, connect_timeout: 10 });

// ── Service heartbeat ─────────────────────────────────────────────────────────
async function writeHeartbeat(status = "running", lastError = null) {
  try {
    await sql`
      INSERT INTO service_health (name, status, pid, last_heartbeat_at, last_error, started_at, updated_at)
      VALUES (${SERVICE_NAME}, ${status}, ${process.pid}, now(), ${lastError}, now(), now())
      ON CONFLICT (name) DO UPDATE SET
        status = ${status}, pid = ${process.pid}, last_heartbeat_at = now(),
        last_error = COALESCE(${lastError}, service_health.last_error), updated_at = now()
    `;
  } catch (err) {
    console.warn("[agenda-scheduler] Heartbeat write failed:", err.message);
  }
}

// ── OpenClaw cron helpers (direct gateway RPC — no subprocess) ───────────────
//
// Uses OpenClaw's callGateway() directly instead of spawning `openclaw cron`
// CLI subprocesses. Cold call: ~1.5s (module load). Warm calls: ~9ms.
// This eliminates the 10s CPU spike per CLI invocation that caused the
// 15%↔ 30% CPU oscillation on every 15s scheduler tick.

/** Create a one-shot cron job for an occurrence. Returns the cron job ID. */
async function createCronJob({ title, message, agentId, model, scheduledFor, sessionTarget, timeoutSeconds }) {
  const scheduledMs = new Date(scheduledFor).getTime();
  const msUntil = scheduledMs - Date.now();
  if (msUntil <= 0) {
    console.log(`[agenda-scheduler] createCronJob: scheduling IMMEDIATE (was due ${Math.round(-msUntil/1000)}s ago) for "${title}"`);
  }
  const target = (sessionTarget === "main" || sessionTarget === "isolated") ? sessionTarget : "isolated";
  const isMain = target === "main";

  const effectiveMessage = isMain
    ? `[Agenda Task: ${title}]\n\n${message}\n\n(Agenda system instructions above — respond to the task, do not repeat these instructions.)`
    : message;
  const truncatedMessage = isMain && effectiveMessage.length > 4000
    ? effectiveMessage.slice(0, 4000) + '\n\n[Instructions truncated for session size — respond to the task above.]'
    : effectiveMessage;

  // Build the cron.add params matching the gateway's WS RPC schema
  const params = {
    name: `MC: ${title}`,
    enabled: true,
    deleteAfterRun: true,
    agentId: agentId || "main",
    sessionTarget: target,
    schedule: {
      kind: "at",
      // For past timestamps, schedule 1s from now so cron fires immediately
      at: msUntil > 0 ? new Date(scheduledFor).toISOString() : new Date(Date.now() + 1000).toISOString(),
    },
    payload: isMain
      ? { kind: "systemEvent", text: truncatedMessage }
      : { kind: "agentTurn", message: truncatedMessage },
    delivery: isMain
      ? undefined
      : { mode: "none" },  // Isolated runs: no Telegram noise
  };

  // Model override only applies to agentTurn (isolated) payloads
  if (!isMain && model?.trim()) {
    params.payload.model = model.trim();
  }
  if (timeoutSeconds && Number.isFinite(Number(timeoutSeconds))) {
    params.payload.timeoutSeconds = Math.max(60, Number(timeoutSeconds));
  }

  const result = await callCron("cron.add", params, { timeoutMs: 20000 });
  return result?.id || null;
}

/**
 * Returns a Set of cron job IDs that currently exist in the gateway.
 * Uses persistent WS RPC instead of spawning CLI subprocess.
 * Used to detect orphaned occurrences whose cron jobs were lost during restart.
 */
async function getLiveCronJobIds() {
  try {
    const result = await callCron("cron.list", { includeDisabled: false }, { timeoutMs: 10000 });
    const jobs = Array.isArray(result) ? result : (result?.jobs ?? result?.data ?? []);
    // Exclude MC-notify: jobs — those are bridge-logger completion notifications,
    // not occurrence cron jobs. They have no DB occurrence backing them.
    return new Set(
      jobs
        .filter((j) => !String(j.name || "").startsWith("MC-notify:"))
        .map((j) => j.id)
        .filter(Boolean)
    );
  } catch (err) {
    console.warn("[agenda-scheduler] Could not fetch live cron job list:", err.message);
    return null; // null = don't sweep (gateway may be overloaded; skip this cycle)
  }
}

/**
 * Fetch the most recent run state for a cron job from the gateway's persisted
 * run history (the `cron.runs` RPC). Run history survives `deleteAfterRun`
 * cleanup, so this lets the orphan sweep tell "finished & auto-deleted" (state
 * 'ok') apart from "died mid-run" (no run record / still 'running') — a
 * distinction `cron.list` alone cannot make, and the root cause of successful
 * occurrences being mislabeled needs_retry.
 *
 * Returns one of the documented run states ('ok' | 'error' | 'skipped' |
 * 'running') lowercased, or null when unknown/unavailable. Callers MUST treat
 * null as "no positive evidence of success" and fall back to safe behaviour.
 *
 * Defensive on purpose: the run-history shape is validated against the cron run
 * JSONL the gateway writes (~/.openclaw/cron/runs/<jobId>.jsonl: { status,
 * runAtMs, ... }). The id is sent as both `id` and `jobId` since extra params
 * are ignored; any RPC drift or error returns null, degrading the sweep to its
 * previous cron.list-only behaviour rather than misfiring.
 */
async function getJobLastRunState(jobId) {
  try {
    const result = await callCron("cron.runs", { id: jobId, jobId, limit: 5 }, { timeoutMs: 10000 });
    const runs = Array.isArray(result) ? result : (result?.runs ?? result?.data ?? []);
    if (!Array.isArray(runs) || runs.length === 0) return null;
    // Pick the most recent run — tolerant about ordering and timestamp field name.
    const latest = runs.reduce((newest, r) => {
      const t = new Date(r?.startedAt ?? r?.runAt ?? r?.runAtMs ?? 0).getTime();
      const nt = new Date(newest?.startedAt ?? newest?.runAt ?? newest?.runAtMs ?? 0).getTime();
      return t >= nt ? r : newest;
    }, runs[0]);
    const state = latest?.status ?? latest?.state ?? latest?.result ?? null;
    return state ? String(state).toLowerCase() : null;
  } catch (err) {
    console.warn(`[agenda-scheduler] cron.runs lookup failed for ${jobId}: ${err.message}`);
    return null;
  }
}

// ── RRULE expansion (unchanged from v1 — works well) ─────────────────────────
function localTimeToUTC(localDateStr, localTimeStr, timezone) {
  const targetLocal = `${localDateStr}T${localTimeStr}`;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const get = (parts) => {
    const g = (type) => parts.find((p) => p.type === type)?.value ?? "";
    return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
  };
  const base = new Date(`${localDateStr}T${localTimeStr}:00Z`);
  for (let offsetH = -12; offsetH <= 14; offsetH++) {
    const candidate = new Date(base.getTime() - offsetH * 3600000);
    const rendered = get(fmt.formatToParts(candidate));
    if (rendered === targetLocal) return candidate;
  }
  return new Date(base.getTime() - 3600000);
}

function extractLocalTime(utcDate, timezone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(utcDate);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

async function expandOccurrences(event, from, to) {
  const startDate = new Date(event.starts_at);
  const until = event.recurrence_until ? new Date(event.recurrence_until) : to;
  const rangeEnd = new Date(Math.min(to.getTime(), until.getTime()));

  if (!event.recurrence_rule || event.recurrence_rule === "null" || event.recurrence_rule === "none") {
    return startDate >= from && startDate <= to ? [startDate] : [];
  }
  try {
    const rruleMod = await import("rrule");
    const RRule = rruleMod?.RRule ?? rruleMod?.default?.RRule;
    if (!RRule) throw new Error("rrule module did not expose RRule");
    const tz = event.timezone || "UTC";
    const { time: localTime } = extractLocalTime(startDate, tz);
    const opts = RRule.parseString(event.recurrence_rule);
    opts.dtstart = startDate;
    const rule = new RRule(opts);
    const rawDates = rule.between(from, rangeEnd, true);
    const [lh, lm] = localTime.split(":").map(Number);
    const snappedMin = Math.round(lm / 15) * 15;
    const snappedH = snappedMin >= 60 ? (lh + 1) % 24 : lh;
    const snappedM = snappedMin >= 60 ? 0 : snappedMin;
    const snappedTime = `${String(snappedH).padStart(2, "0")}:${String(snappedM).padStart(2, "0")}`;
    return rawDates.map((d) => {
      const { date: occDate } = extractLocalTime(d, tz);
      return localTimeToUTC(occDate, snappedTime, tz);
    });
  } catch (err) {
    console.warn(`[agenda-scheduler] RRULE expansion failed for event=${event.id}:`, err.message);
    return startDate >= from && startDate <= to ? [startDate] : [];
  }
}

// ── Prompt rendering helper ───────────────────────────────────────────────────
async function renderPromptForEvent(event, occurrenceId) {
  const [override] = await sql`
    SELECT overridden_title, overridden_free_prompt, overridden_agent_id
    FROM agenda_occurrence_overrides
    WHERE occurrence_id = ${occurrenceId}
    LIMIT 1
  `;

  const effectiveTitle = String(override?.overridden_title || event.title || "Agenda task").trim();
  const effectivePrompt = override?.overridden_free_prompt !== undefined && override?.overridden_free_prompt !== null
    ? String(override.overridden_free_prompt)
    : (event.free_prompt ? String(event.free_prompt) : "");
  const effectiveAgentId = String(override?.overridden_agent_id || event.default_agent_id || "main").trim() || "main";

  // Load process steps if any
  const processes = await sql`
    select aep.process_version_id, aep.sort_order
    from agenda_event_processes aep
    where aep.agenda_event_id = ${event.id}
    order by aep.sort_order asc
  `;

  const composedSteps = [];
  let seq = 1;
  for (const proc of processes) {
    const stepRows = await sql`
      select * from process_steps
      where process_version_id = ${proc.process_version_id}
      order by step_order asc
    `;
    for (const stepRow of stepRows) {
      composedSteps.push({
        order: seq++,
        title: stepRow.title || `Step ${stepRow.step_order}`,
        instruction: String(stepRow.instruction || ""),
        skillKey: stepRow.skill_key || null,
      });
    }
  }

  // Build a stable, occurrence-scoped artifact path.
  // No random UUIDs — deterministic so the agent always writes to the same place.
  // Path: runtime-artifacts/agenda/{eventId}/occurrences/{occurrenceId}/artifacts
  const artifactDir = getOccurrenceArtifactDir({
    eventId: event.id,
    occurrenceId: occurrenceId || "unknown",
  });

  // Main-session events get a clean prompt — Execution rules / Output rules
  // are internal framework instructions that would leak into the user's chat.
  const isMainSession = event.session_target === "main";

  // Inject a unique marker into the task text. Bridge-logger uses this to locate
  // the exact injection point in the session file regardless of when the task fired,
  // solving the session_line_offset capture-time mismatch problem.
  // Prefixed with # so it reads as a comment/directive to the model rather than
  // user content. The system-prompt framing hides it from the model's main context.
  const rendered = renderUnifiedTaskMessage({
    title: effectiveTitle,
    instructions: composedSteps,
    request: effectivePrompt,
    artifactDir,
    isMainSession,
  });

  return {
    title: effectiveTitle,
    agentId: effectiveAgentId,
    message: isMainSession
      ? `# AGENDA_MARKER:occurrence_id=${occurrenceId}\n\n${rendered}`
      : rendered,
  };
}




// ── Dependency check ──────────────────────────────────────────────────────────
/**
 * Check if event B's dependency (depends_on_event_id) is satisfied for a
 * given scheduled time window.
 *
 * Returns:
 *   { ok: true }                  — no dependency or dependency succeeded
 *   { ok: false, skip: true,  reason }  — dependency failed/missed → skip this occurrence
 *   { ok: false, skip: false, reason }  — dependency still running/queued → wait (retry next cycle)
 *
 * "Matching occurrence" = closest occurrence of event A whose scheduled_for
 * falls within ±24h of B's scheduled_for. This handles slight timing offsets
 * between recurring events without mixing up different days.
 */
async function checkDependency(sql, event, scheduledFor) {
  if (!event.depends_on_event_id) return { ok: true };

  const window = 24 * 3600 * 1000; // ±24h match window
  const from = new Date(scheduledFor.getTime() - window);
  const to   = new Date(scheduledFor.getTime() + window);

  const [depOcc] = await sql`
    SELECT ao.id, ao.status, ao.scheduled_for, ao.skip_reason
    FROM agenda_occurrences ao
    WHERE ao.agenda_event_id = ${event.depends_on_event_id}
      AND ao.scheduled_for BETWEEN ${from} AND ${to}
    ORDER BY ABS(EXTRACT(EPOCH FROM (ao.scheduled_for - ${scheduledFor}::timestamptz)))
    LIMIT 1
  `;

  // Dependency occurrence doesn't exist yet — event A hasn't been scheduled this cycle.
  // Wait; it will appear on a future cycle.
  if (!depOcc) {
    return { ok: false, skip: false, reason: "Dependency occurrence not yet scheduled — waiting" };
  }

  if (depOcc.status === 'succeeded') {
    return { ok: true };
  }

  // Dependency skipped/failed/cancelled → skip B too (don't pile up broken chain)
  if (['failed', 'cancelled', 'skipped'].includes(depOcc.status)) {
    return {
      ok: false, skip: true,
      reason: `Dependency event failed/skipped (occurrence ${depOcc.id}, status: ${depOcc.status}) — skipping this occurrence`,
    };
  }

  // Dependency needs_retry — skip B; user must fix A first
  if (depOcc.status === 'needs_retry') {
    return {
      ok: false, skip: true,
      reason: `Dependency occurrence ${depOcc.id} needs_retry — skipping until A is resolved`,
    };
  }

  // Check timeout if configured
  if (event.dependency_timeout_hours) {
    const ageHours = (Date.now() - new Date(depOcc.scheduled_for).getTime()) / 3_600_000;
    if (ageHours > event.dependency_timeout_hours) {
      return {
        ok: false, skip: true,
        reason: `Dependency timed out after ${event.dependency_timeout_hours}h (occurrence ${depOcc.id} still ${depOcc.status})`,
      };
    }
  }

  // A is queued/running/scheduled — B waits
  return {
    ok: false, skip: false,
    reason: `Waiting for dependency occurrence ${depOcc.id} (status: ${depOcc.status})`,
  };
}

// ── Main scheduling cycle ─────────────────────────────────────────────────────
async function runCycle() {
  const now = new Date();
  // Lookahead: from the epoch (to catch all unscheduled past occurrences) up to LOOKAHEAD_DAYS
  // The expansion window still uses a sensible from for RRULE (go back 30 days max to avoid
  // computing thousands of historical dates for high-frequency events)
  const rruleFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30d back for RRULE expansion
  const to = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  // Load all active events
  const events = await sql`
    SELECT ae.*, w.id as workspace_id
    FROM agenda_events ae
    JOIN workspaces w ON w.id = ae.workspace_id
    WHERE ae.status = 'active'
  `;

  // ── Dead-cron-job sweep (gateway restart recovery) ──────────────────────────
  // Fetch all live cron job IDs from the gateway via persistent WS RPC.
  // This is now fast (~ms) since it uses the shared WebSocket connection
  // instead of spawning a 10s CLI subprocess.
  const liveCronIds = await getLiveCronJobIds();
  if (liveCronIds !== null) {
    // ── 1. Queued/scheduled orphans: cron job gone → reschedule ──────────────
    const orphaned = await sql`
      SELECT ao.id, ao.cron_job_id
      FROM agenda_occurrences ao
      WHERE ao.status = 'queued'
        AND ao.cron_job_id IS NOT NULL
        AND ao.scheduled_for <= ${new Date(now.getTime() + 48 * 3600_000)}
    `;
    for (const row of orphaned) {
      if (!liveCronIds.has(row.cron_job_id)) {
        await sql`
          UPDATE agenda_occurrences
          SET cron_job_id = NULL, status = 'scheduled'
          WHERE id = ${row.id} AND status = 'queued' AND cron_job_id = ${row.cron_job_id}
        `;
        console.warn(`[agenda-scheduler] Orphaned cron job ${row.cron_job_id} for occurrence ${row.id} — will reschedule`);
      }
    }

    // ── 2. Running orphans: cron job gone mid-run → immediate needs_retry ────
    // This is faster and more accurate than waiting for execution_window to expire.
    // If the cron job that launched this run no longer exists, the agent session
    // died (gateway restart, OOM, etc.) and will never write a result.
    const runningOrphans = await sql`
      SELECT ao.id, ao.cron_job_id, ae.title
      FROM agenda_occurrences ao
      JOIN agenda_events ae ON ae.id = ao.agenda_event_id
      WHERE ao.status = 'running'
        AND ao.cron_job_id IS NOT NULL
        AND ao.locked_at < NOW() - INTERVAL '2 minutes'
    `;
    for (const row of runningOrphans) {
      if (liveCronIds.has(row.cron_job_id)) continue;

      // The cron job is absent from the live list. Because occurrence jobs are
      // created with deleteAfterRun:true, the gateway ALSO auto-deletes a job the
      // instant it finishes successfully — so "not live" does NOT imply "died".
      // Consult the persisted run history (survives deleteAfterRun) before
      // condemning; otherwise we mis-flag completed runs as needs_retry and kick
      // off a wasteful, often duplicate, re-run while bridge-logger is still
      // finalizing the same occurrence to 'succeeded' from the cron run result file.
      const lastRunState = await getJobLastRunState(row.cron_job_id);
      if (lastRunState === 'ok') {
        console.log(`[agenda-scheduler] Occurrence ${row.id} ("${row.title}") cron job ${row.cron_job_id} gone but run history=ok — not orphaned, leaving for bridge-logger to finalize`);
        continue;
      }
      if (lastRunState === 'running') {
        // Run still reports in-flight; give it another cycle rather than condemning.
        continue;
      }

      // lastRunState is 'error'/'skipped' (genuine failure) or null (no run record
      // → the session died before producing any run). Both are safe to retry.
      const updated = await sql`
        UPDATE agenda_occurrences
        SET status = 'needs_retry',
            last_retry_reason = ${`ORPHANED: cron job disappeared mid-run (run history state: ${lastRunState ?? 'none'}) — safe to retry`},
            cron_job_id = NULL
        WHERE id = ${row.id} AND status = 'running'
        RETURNING id
      `;
      if (updated.length > 0) {
        console.warn(`[agenda-scheduler] Running occurrence ${row.id} ("${row.title}") orphaned (cron job ${row.cron_job_id} gone, run state=${lastRunState ?? 'none'}) → needs_retry`);
        await sql`SELECT pg_notify('agenda_change', ${JSON.stringify({ action: 'needs_retry', occurrenceId: row.id })})`;
      }
    }
  }

  let scheduled = 0;

  for (const event of events) {
    try {
      const occurrences = await expandOccurrences(event, rruleFrom, to);

      // Sort oldest first so catch-up fires in chronological order
      occurrences.sort((a, b) => a.getTime() - b.getTime());

      for (const scheduledFor of occurrences) {
        // Upsert occurrence row
        const occInsertResult = await sql`
          INSERT INTO agenda_occurrences (agenda_event_id, scheduled_for, status)
          VALUES (${event.id}, ${scheduledFor}, 'scheduled')
          ON CONFLICT (agenda_event_id, scheduled_for) DO NOTHING
          RETURNING id
        `;
        const wasNewOccurrence = occInsertResult.length > 0;

        const [occ] = await sql`
          SELECT ao.id, ao.status, ao.cron_job_id, o.overridden_starts_at
          FROM agenda_occurrences ao
          LEFT JOIN agenda_occurrence_overrides o ON o.occurrence_id = ao.id
          WHERE ao.agenda_event_id = ${event.id} AND ao.scheduled_for = ${scheduledFor}
        `;
        if (!occ) continue;

        const effectiveScheduledFor = occ.overridden_starts_at
          ? new Date(occ.overridden_starts_at)
          : scheduledFor;

        if (wasNewOccurrence) {
          await emitSchedulerLog(sql, {
            workspaceId: event.workspace_id,
            agentId: event.default_agent_id || "main",
            occurrenceId: occ.id,
            eventType: "agenda.created",
            level: "info",
            message: `Occurrence created for event "${event.title}" scheduled at ${scheduledFor.toISOString()}`,
          });
        }

        // Skip terminal states — never re-fire completed/cancelled/failed work
        if (["succeeded", "failed", "cancelled", "needs_retry", "skipped"].includes(occ.status)) continue;

        // Skip if already has a live cron job
        if (occ.cron_job_id) continue;

        // ── Dependency check ───────────────────────────────────────────────
        const dep = await checkDependency(sql, event, effectiveScheduledFor);
        if (!dep.ok) {
          if (dep.skip) {
            // Dependency failed/timed-out — skip this occurrence permanently
            await sql`
              UPDATE agenda_occurrences
              SET status = 'skipped', skip_reason = ${dep.reason}
              WHERE id = ${occ.id} AND status NOT IN ('succeeded','failed','cancelled','skipped','needs_retry')
            `;
            await sql`SELECT pg_notify('agenda_change', ${JSON.stringify({ action: 'skipped', occurrenceId: occ.id })})`;
            await emitSchedulerLog(sql, {
              workspaceId: event.workspace_id,
              agentId: event.default_agent_id || "main",
              occurrenceId: occ.id,
              eventType: "agenda.skipped",
              level: "warning",
              message: `Occurrence skipped (dependency): ${dep.reason}`,
            });
            console.warn(`[agenda-scheduler] Occurrence ${occ.id} ("${event.title}") skipped: ${dep.reason}`);
          } else {
            // Dependency still pending — log and wait for next cycle
            console.log(`[agenda-scheduler] Occurrence ${occ.id} ("${event.title}") waiting: ${dep.reason}`);
          }
          continue;
        }

        // Schedule window: past occurrences (any age) get fired immediately as catch-up.
        // Future occurrences beyond 48h get their cron job created when they come closer.
        const hoursUntil = (effectiveScheduledFor.getTime() - now.getTime()) / 3600000;
        if (hoursUntil > 48) continue;
        // Note: no lower floor — hoursUntil may be negative (missed/past), these get --at 30s

        // ── Per-occurrence scheduling (isolated so one failure doesn't block others) ──
        // Wrapped in try/catch: if renderPromptForEvent throws, the occurrence is
        // left in 'scheduled' with no cron job — we must mark it needs_retry immediately.
        try {
          // Render the prompt with the stable, occurrence-scoped artifact path baked in.
          const rendered = await renderPromptForEvent(event, occ.id);

          // Persist the rendered prompt so retries always use the exact same message.
          await sql`UPDATE agenda_occurrences SET rendered_prompt = ${rendered.message} WHERE id = ${occ.id}`;

          // Log catch-up fires (past occurrences being scheduled now due to missed window)
          if (hoursUntil < -0.5) {
            const hoursAgo = Math.round(-hoursUntil * 10) / 10;
            console.warn(`[agenda-scheduler] Catch-up: occurrence ${occ.id} was scheduled ${hoursAgo}h ago — firing immediately`);
          }

          // ── Session injection boundary (main session only) ───────────────────────
          // Capture the session file's line count immediately before the cron job
          // fires. Bridge-logger reads from this offset onwards so it only sees
          // output from this specific task, not earlier messages in the shared
          // agent:main:main session file. Isolated sessions have their own files
          // so no injection boundary is needed.
          const sessionTarget = event.session_target || "isolated";
          if (sessionTarget === "main") {
            const lineOffset = await getMainSessionLineOffset();
            if (lineOffset !== null) {
              await sql`UPDATE agenda_occurrences SET session_line_offset = ${lineOffset} WHERE id = ${occ.id}`;
              console.log(`[agenda-scheduler] main-session line offset captured: occurrence ${occ.id} @ line ${lineOffset}`);
            } else {
              console.warn(`[agenda-scheduler] could not capture main-session line offset for occurrence ${occ.id} — output resolution will fall back to full-session scan`);
            }
          }

          // Create the cron job — session target from event config (default: isolated)
          const cronJobId = await createCronJob({
            title: rendered.title,
            message: rendered.message,
            agentId: rendered.agentId,
            model: sessionTarget === "main" ? null : (event.model_override || null),
            scheduledFor: effectiveScheduledFor,
            sessionTarget,
            timeoutSeconds: null,
          });

          if (!cronJobId) {
            console.warn(`[agenda-scheduler] Failed to create cron job for occurrence ${occ.id} — marking needs_retry`);
            await emitSchedulerLog(sql, {
              workspaceId: event.workspace_id,
              agentId: event.default_agent_id || "main",
              occurrenceId: occ.id,
              eventType: "agenda.error",
              level: "error",
              message: `Failed to create cron job for event "${rendered.title}" — occurrence marked needs_retry`,
            });
            await transitionOccurrenceToNeedsRetry(sql, {
              occurrenceId: occ.id,
              reasonCode: "PROVIDER_REJECTED",
              reasonText: "Cron job creation failed — check gateway logs",
            });
            await sql`
              INSERT INTO agenda_run_attempts
                (occurrence_id, attempt_no, status, started_at, finished_at, summary, error_message)
              VALUES
                (${occ.id}, 1, 'failed', now(), now(),
                 'Failed to create cron job', 'Cron job creation failed — check gateway logs')
              ON CONFLICT DO NOTHING
            `;
            await sql`SELECT pg_notify('agenda_change', ${JSON.stringify({ action: "needs_retry", occurrenceId: occ.id })})`;
            continue;
          }

          // Atomically mark queued with the cron job ID
          await transitionOccurrenceToQueued(sql, {
            occurrenceId: occ.id,
            cronJobId,
          });

          await emitSchedulerLog(sql, {
            workspaceId: event.workspace_id,
            agentId: event.default_agent_id || "main",
            occurrenceId: occ.id,
            eventType: "agenda.queued",
            level: "info",
            message: `Cron job created — event "${rendered.title}" picked up at ${new Date().toISOString()} (cron job ${cronJobId})`,
            rawPayload: { cronJobId, scheduledFor: effectiveScheduledFor.toISOString() },
          });

          scheduled++;
          console.log(`[agenda-scheduler] Scheduled occurrence ${occ.id} → cron job ${cronJobId}`);
        } catch (err) {
          // renderPromptForEvent threw (malformed steps, missing skill, bad artifact path, etc.)
          // OR the SQL update / cron creation threw — mark the occurrence failed immediately
          // so it is never left in 'scheduled' with no cron job.
          console.error(`[agenda-scheduler] Occurrence ${occ.id} scheduling failed: ${err.message}`);
          await emitSchedulerLog(sql, {
            workspaceId: event.workspace_id,
            agentId: event.default_agent_id || "main",
            occurrenceId: occ.id,
            eventType: "agenda.error",
            level: "error",
            message: `Occurrence scheduling failed: ${err.message} — marked needs_retry`,
          });
          await transitionOccurrenceToNeedsRetry(sql, {
            occurrenceId: occ.id,
            reasonCode: "RENDER_FAILED",
            reasonText: err.message.slice(0, 500),
          });
          await sql`
            INSERT INTO agenda_run_attempts
              (occurrence_id, attempt_no, status, started_at, finished_at, summary, error_message)
            VALUES
              (${occ.id}, 1, 'failed', now(), now(),
               'Occurrence scheduling failed: ' || ${err.message.slice(0, 200)}, ${err.message.slice(0, 500)})
            ON CONFLICT DO NOTHING
          `;
          await sql`SELECT pg_notify('agenda_change', ${JSON.stringify({ action: "needs_retry", occurrenceId: occ.id })})`;
          continue;
        }
      }
    } catch (err) {
      console.error(`[agenda-scheduler] Event processing failed for event=${event.id}:`, err.message);
    }
  }

  // ── Stale-running sweep ───────────────────────────────────────────────────────────────
  // Occurrences stuck in 'running' past their event’s execution_window_minutes are
  // timed out and sent to needs_retry so the user can investigate.
  // Per-event window is respected — a 2-hour report task won’t be killed at 15 min.
  try {
    const stale = await transitionStaleRunningToNeedsRetry(sql, {
      reason: "WORKER_STALLED: execution exceeded event window — check agent logs",
      defaultMinutes: 60,
    });
    if (stale.length > 0) {
      for (const row of stale) {
        const windowLabel = row.execution_window_minutes ? `${row.execution_window_minutes}min` : "60min (default)";
        console.warn(`[agenda-scheduler] Stale occurrence ${row.id} ("${row.title}") exceeded ${windowLabel} window → needs_retry`);
        await sql`SELECT pg_notify('agenda_change', ${JSON.stringify({ action: "needs_retry", occurrenceId: row.id })})`;
      }
    }
  } catch (err) {
    console.warn("[agenda-scheduler] Stale-running sweep failed (non-fatal):", err.message);
  }

  console.log(`[agenda-scheduler] Cycle complete — ${events.length} events, ${scheduled} new cron jobs created`);
}

// ── Startup ───────────────────────────────────────────────────────────────────
try {
  await assertAgendaSchema(sql);
  console.log("[agenda-scheduler] Schema assertion passed");
} catch (err) {
  console.error("[agenda-scheduler] Schema assertion failed:", err?.message || err);
  process.exit(1);
}

await writeHeartbeat("running");
const heartbeatInterval = setInterval(() => writeHeartbeat("running"), 30_000);

let runInProgress = false;
let wakeTimer = null;
async function tick(reason = "interval") {
  if (runInProgress) {
    console.warn(`[agenda-scheduler] Previous cycle still running, skipping tick (${reason})`);
    return;
  }
  runInProgress = true;
  try {
    console.log(`[agenda-scheduler] Tick start (${reason})`);
    await runCycle();
    await writeHeartbeat("running", null);
  } catch (err) {
    console.error(`[agenda-scheduler] Cycle failed (${reason}):`, err.message);
    await writeHeartbeat("degraded", err.message);
  } finally {
    runInProgress = false;
  }
}

function scheduleWake(reason = "external", delayMs = SCHEDULER_WAKE_DEBOUNCE_MS) {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void tick(`wake:${reason}`);
  }, Math.max(0, delayMs));
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[agenda-scheduler] Shutting down...");
  clearInterval(heartbeatInterval);
  if (wakeTimer) clearTimeout(wakeTimer);
  // gateway-rpc module uses ephemeral connections; no persistent client to destroy.
  await writeHeartbeat("stopped").catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("unhandledRejection", (reason) => console.error("[agenda-scheduler] Unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("[agenda-scheduler] Uncaught exception:", err));

void tick("startup");
setInterval(() => void tick("interval"), SCHEDULER_TICK_MS);

// ── Fallback model listener ────────────────────────────────────────────────────────
// bridge-logger emits pg_notify('agenda_change', { action:'needs_retry', scheduleFallback:true })
// when a run fails and a fallback model is configured.
// We react here by creating a new cron job with the fallback model.
try {
  await sql.listen("agenda_change", async (payload) => {
    let data;
    try { data = JSON.parse(payload); } catch { return; }

    const action = String(data?.action || "");
    if (["create", "update", "delete", "test_create", "force_delete_events"].includes(action)) {
      console.log(`[agenda-scheduler] Wake requested from agenda_change action=${action}`);
      scheduleWake(action);
    }

  });
  console.log(`[agenda-scheduler] Listening for agenda_change signals (tick=${SCHEDULER_TICK_MS}ms, wakeDebounce=${SCHEDULER_WAKE_DEBOUNCE_MS}ms)`);
} catch (err) {
  console.warn("[agenda-scheduler] Failed to set up fallback listener (non-fatal):", err.message);
}

console.log("[agenda-scheduler] Started — cron-based scheduler active");
