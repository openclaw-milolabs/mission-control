import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { RRule } from "rrule";
import { DateTime } from "luxon";

type Json = Record<string, unknown>;

const ok = (data: Json = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

// Luxon-based timezone helpers for DST-safe RRULE expansion
function extractLocalTime(utcDate: Date, timezone: string) {
  const dt = DateTime.fromJSDate(utcDate, { zone: timezone });
  return {
    date: dt.toISODate() ?? "",
    time: `${String(dt.hour).padStart(2, "0")}:${String(dt.minute).padStart(2, "0")}`,
  };
}

function localTimeToUTC(localDateStr: string, localTimeStr: string, timezone: string): Date {
  // Parse the local date+time in the given timezone, then convert to UTC
  // Luxon handles DST transitions automatically (e.g. spring-forward gaps)
  const [year, month, day] = localDateStr.split("-").map(Number);
  const [hour, minute] = localTimeStr.split(":").map(Number);
  const dt = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { zone: timezone }
  );
  return dt.toUTC().toJSDate();
}

/**
 * Parse a datetime string from the client.
 * Accepts two formats:
 * 1. Local time (no Z/offset): "2026-04-01T18:50:00" — converted to UTC using the given timezone
 * 2. UTC time (with Z): "2026-04-01T16:50:00.000Z" — parsed directly (backward compat)
 */
function parseClientDateTime(value: string, timezone: string): Date | null {
  if (!value) return null;
  const str = String(value);
  // If it ends with Z or has a timezone offset (+HH:MM / -HH:MM), it's already UTC
  if (/Z$|[+-]\d{2}:\d{2}$/.test(str)) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  // Otherwise it's a local time string like "2026-04-01T18:50:00"
  const [datePart, timePart] = str.split("T");
  if (!datePart || !timePart) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }
  const localTime = timePart.slice(0, 5); // "HH:mm"
  return localTimeToUTC(datePart, localTime, timezone);
}

async function workspaceId(sql: ReturnType<typeof getSql>) {
  const rows = await sql`select id from workspaces order by created_at asc limit 1`;
  return rows[0]?.id ?? null;
}

export async function GET(request: Request) {
  try {
    const sql = getSql();
    const wid = await workspaceId(sql);
    if (!wid) return ok({ events: [] });

    const url = new URL(request.url);
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");

    let events;
    if (start && end) {
      events = await sql`
        select
          ae.*,
          coalesce(
            (select json_agg(json_build_object(
              'id', aep.id,
              'process_version_id', aep.process_version_id,
              'sort_order', aep.sort_order,
              'process_name', p.name,
              'version_number', pv.version_number
            ) order by aep.sort_order)
            from agenda_event_processes aep
            join process_versions pv on pv.id = aep.process_version_id
            join processes p on p.id = pv.process_id
            where aep.agenda_event_id = ae.id),
            '[]'
          ) as processes
        from agenda_events ae
        where ae.workspace_id = ${wid}
          and (
            (${start}::timestamptz is not null and ae.starts_at <= ${end}::timestamptz)
            and (${end}::timestamptz is not null and (ae.ends_at is null or ae.ends_at >= ${start}::timestamptz))
          )
        order by ae.starts_at asc
      `;
    } else {
      events = await sql`
        select
          ae.*,
          coalesce(
            (select json_agg(json_build_object(
              'id', aep.id,
              'process_version_id', aep.process_version_id,
              'sort_order', aep.sort_order,
              'process_name', p.name,
              'version_number', pv.version_number
            ) order by aep.sort_order)
            from agenda_event_processes aep
            join process_versions pv on pv.id = aep.process_version_id
            join processes p on p.id = pv.process_id
            where aep.agenda_event_id = ae.id),
            '[]'
          ) as processes
        from agenda_events ae
        where ae.workspace_id = ${wid}
        order by ae.starts_at asc
      `;
    }

    // Expand recurring events using RRULE
    if (start && end) {
      const rangeStart = new Date(start);
      const rangeEnd = new Date(end);
      // Set rangeEnd to end of day so the last day is included
      rangeEnd.setHours(23, 59, 59, 999);

      // Add ±1 day buffer for RRULE expansion to handle timezone edge cases
      // (e.g. event at 23:04 UTC shows as next day in CET)
      const rruleStart = new Date(rangeStart.getTime() - 86_400_000);
      const rruleEnd = new Date(rangeEnd.getTime() + 86_400_000);

      const expanded: Array<Record<string, unknown>> = [];
      const recurringEventIds: string[] = [];

      for (const event of events) {
        if (!event.recurrence_rule || event.recurrence_rule === "null" || event.recurrence_rule === "none") {
          expanded.push(event);
          continue;
        }

        recurringEventIds.push(event.id);

        try {
          const eventStart = new Date(event.starts_at);

          const rruleOptions = RRule.parseString(event.recurrence_rule);
          rruleOptions.dtstart = eventStart;

          // For recurring events, ends_at = series end date (not per-occurrence duration).
          // Use recurrence_until first, fall back to ends_at as the series cap.
          const seriesEnd = event.recurrence_until
            ? new Date(event.recurrence_until)
            : event.ends_at
              ? new Date(event.ends_at)
              : null;
          if (seriesEnd) {
            rruleOptions.until = seriesEnd;
          }

          const rule = new RRule(rruleOptions);

          // Use buffered range for RRULE — then re-anchor each to original local time
          // so DST changes don't shift the event (02:08 CET stays 02:08 CEST)
          const rawOccurrences = rule.between(rruleStart, rruleEnd, true);
          const tz = event.timezone || "UTC";
          const { time: localTime } = extractLocalTime(eventStart, tz);

          for (const rawOcc of rawOccurrences) {
            const { date: occLocalDate } = extractLocalTime(rawOcc, tz);
            const correctedOcc = localTimeToUTC(occLocalDate, localTime, tz);
            const { date: correctedDate } = extractLocalTime(correctedOcc, tz);
            expanded.push({
              ...event,
              starts_at: correctedOcc.toISOString(),
              // For recurring events, ends_at is the series end — not per-occurrence duration.
              // Each occurrence has no individual end time (they run at the scheduled moment).
              ends_at: null,
              // Store the series end separately so the UI can display "until April 17" etc.
              _seriesEndsAt: event.ends_at ?? null,
              _occurrenceDate: correctedDate,
              // scheduled_for: ISO timestamp of this specific occurrence — used for the cron
              // timer countdown in the FullCalendar UI (distinct from series starts_at).
              scheduled_for: correctedOcc.toISOString(),
              // Preserve the intended local time for display, even across DST gaps
              // (e.g. 02:08 CET doesn't exist on spring-forward day, but we still want to show "02:08")
              _intendedLocalTime: localTime,
            });
          }
        } catch {
          // If RRULE parsing fails, return event as-is
          expanded.push(event);
        }
      }

      // Attach per-occurrence status for recurring events
      // (each expanded day should show its own occurrence status, not the global latest)
      const expandedIds = expanded.map((e) => (e as Record<string, unknown>).id).filter(Boolean);
      if (expandedIds.length > 0) {
        if (recurringEventIds.length > 0) {
          // For recurring: fetch ALL occurrences with run timing and match by scheduled_for date
          // Join agenda_events to get timezone for CET-date key computation
          const allOccRows = await sql`
            select ao.agenda_event_id, ao.scheduled_for, ao.status, ao.locked_at,
                   ra.started_at as run_started_at, ra.finished_at as run_finished_at,
                   ae.timezone as event_timezone
            from agenda_occurrences ao
            left join agenda_run_attempts ra
              on ra.occurrence_id = ao.id and ra.attempt_no = ao.latest_attempt_no
            join agenda_events ae on ae.id = ao.agenda_event_id
            where ao.agenda_event_id = ANY(${recurringEventIds})
          `;
          // Build maps: eventId+date → status, eventId+date → timing
          // Use the EVENT's timezone (not UTC) for the date key so it matches _occurrenceDate
          const occDateMap = new Map<string, string>();
          const occTimingMap = new Map<string, { run_started_at: string | null; run_finished_at: string | null }>();
          for (const r of allOccRows) {
            const tz = (r as Record<string, unknown>).event_timezone as string ?? "UTC";
            const dateKey = extractLocalTime(new Date(r.scheduled_for), tz).date;
            const key = `${r.agenda_event_id}:${dateKey}`;
            occDateMap.set(key, r.status);
            occTimingMap.set(key, {
              run_started_at: r.run_started_at ?? (r.status === "running" ? (r.locked_at ?? r.scheduled_for) : null),
              run_finished_at: r.run_finished_at,
            });
          }
          // Augment each expanded recurring occurrence with its own occurrence status
          for (const e of expanded) {
            const eid = (e as Record<string, unknown>).id as string;
            if (recurringEventIds.includes(eid)) {
              const occDate = ((e as Record<string, unknown>)._occurrenceDate as string) ??
                new Date((e as Record<string, unknown>).starts_at as string).toISOString().split("T")[0];
              const key = `${eid}:${occDate}`;
              (e as Record<string, unknown>).latest_occurrence_status = occDateMap.get(key) ?? null;
              const timing = occTimingMap.get(key);
              if (timing) {
                (e as Record<string, unknown>).run_started_at = timing.run_started_at;
                (e as Record<string, unknown>).run_finished_at = timing.run_finished_at;
              }
            }
          }
        }

        // For non-recurring: use the most relevant occurrence, not simply the latest timestamp.
        // The calendar range view previously picked by scheduled_for desc only, which meant
        // a later queued duplicate occurrence could visually override a just-succeeded run and
        // make the event look "not done". Match the same status-priority ordering used by the
        // non-range query below.
        const nonRecurringIds = expandedIds.filter((id) => !recurringEventIds.includes(id as string));
        if (nonRecurringIds.length > 0) {
          const occRows = await sql`
            select distinct on (ao.agenda_event_id)
              ao.agenda_event_id, ao.status as latest_occurrence_status,
              ao.scheduled_for as next_scheduled_for,
              ao.locked_at,
              ra.started_at as run_started_at, ra.finished_at as run_finished_at
            from agenda_occurrences ao
            left join agenda_run_attempts ra
              on ra.occurrence_id = ao.id and ra.attempt_no = ao.latest_attempt_no
            where ao.agenda_event_id = ANY(${nonRecurringIds as string[]})
              and ao.status <> 'cancelled'
            order by ao.agenda_event_id,
              -- Most-recent occurrence wins. Status priority only breaks ties on
              -- the same scheduled_for (running/needs_retry surface before succeeded
              -- for the same slot, but a newer succeeded always beats an older needs_retry).
              ao.scheduled_for desc,
              case ao.status
                when 'running'     then 1
                when 'needs_retry' then 2
                when 'failed'      then 3
                when 'succeeded'   then 4
                when 'queued'      then 5
                when 'scheduled'   then 6
                else 7
              end
          `;
          const statusMap = new Map<string, { status: string; run_started_at: string | null; run_finished_at: string | null; next_scheduled_for: string | null }>();
          for (const r of occRows) statusMap.set(r.agenda_event_id, {
            status: r.latest_occurrence_status,
            run_started_at: r.run_started_at ?? (r.latest_occurrence_status === "running" ? (r.locked_at ?? r.next_scheduled_for) : null),
            run_finished_at: r.run_finished_at,
            next_scheduled_for: r.next_scheduled_for,
          });
          for (const e of expanded) {
            const eid = (e as Record<string, unknown>).id as string;
            if (!recurringEventIds.includes(eid)) {
              const info = statusMap.get(eid);
              (e as Record<string, unknown>).latest_occurrence_status = info?.status ?? null;
              (e as Record<string, unknown>).scheduled_for = info?.next_scheduled_for ?? (e as Record<string, unknown>).starts_at ?? null;
              if (info) {
                (e as Record<string, unknown>).run_started_at = info.run_started_at;
                (e as Record<string, unknown>).run_finished_at = info.run_finished_at;
              }
            }
          }
        }
      }
      return ok({ events: expanded });
    }

    // Attach latest occurrence status for non-range queries too
    const eventIds = events.map((e: Record<string, unknown>) => e.id).filter(Boolean);
    if (eventIds.length > 0) {
      const occRows = await sql`
        select distinct on (ao.agenda_event_id)
          ao.agenda_event_id,
          ao.status as latest_occurrence_status,
          ao.scheduled_for as next_scheduled_for,
          ao.locked_at,
          ara.started_at as run_started_at,
          ara.finished_at as run_finished_at
        from agenda_occurrences ao
        left join agenda_run_attempts ara
          on ara.occurrence_id = ao.id
          and ara.attempt_no = ao.latest_attempt_no
        where ao.agenda_event_id = ANY(${eventIds as string[]})
          and ao.status <> 'cancelled'
        order by ao.agenda_event_id,
          -- Most-recent occurrence wins. Status priority only breaks ties on
          -- the same scheduled_for (running/needs_retry surface before succeeded
          -- for the same slot, but a newer succeeded always beats an older needs_retry).
          ao.scheduled_for desc,
          case ao.status
            when 'running'     then 1
            when 'needs_retry' then 2
            when 'failed'      then 3
            when 'succeeded'   then 4
            when 'queued'      then 5
            when 'scheduled'   then 6
            else 7
          end
      `;
      const statusMap = new Map<string, { status: string; run_started_at: string | null; run_finished_at: string | null; next_scheduled_for: string | null }>();
      for (const r of occRows) statusMap.set(r.agenda_event_id, {
        status: r.latest_occurrence_status,
        run_started_at: r.run_started_at ?? (r.status === "running" ? (r.locked_at ?? r.next_scheduled_for) : null),
        run_finished_at: r.run_finished_at ?? null,
        next_scheduled_for: r.next_scheduled_for ?? null,
      });
      for (const e of events) {
        const info = statusMap.get((e as Record<string, unknown>).id as string);
        (e as Record<string, unknown>).latest_occurrence_status = info?.status ?? null;
        (e as Record<string, unknown>).scheduled_for = info?.next_scheduled_for ?? (e as Record<string, unknown>).starts_at ?? null;
        (e as Record<string, unknown>).run_started_at = info?.run_started_at ?? null;
        (e as Record<string, unknown>).run_finished_at = info?.run_finished_at ?? null;
      }
    }

    return ok({ events });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load agenda events", 500);
  }
}

export async function POST(request: Request) {
  try {
    const sql = getSql();
    const body = (await request.json()) as Json;
    const action = String(body.action || "");

    const wid = await workspaceId(sql);
    if (!wid) return fail("Workspace not found", 500);

    if (action === "createEvent") {
      const title = String(body.title || "").trim();
      const freePrompt = body.freePrompt ? String(body.freePrompt) : null;
      const agentId = body.agentId && body.agentId !== 'null' ? String(body.agentId) : null;
      const timezone = String(body.timezone || "Europe/Amsterdam");
      const startsAt = body.startsAt ? parseClientDateTime(String(body.startsAt), timezone) : null;
      const endsAt = body.endsAt ? parseClientDateTime(String(body.endsAt), timezone) : null;
      const recurrenceRule = body.recurrenceRule && body.recurrenceRule !== "null" && body.recurrenceRule !== "none" ? String(body.recurrenceRule) : null;
      const recurrenceUntil = body.recurrenceUntil ? new Date(String(body.recurrenceUntil)) : null;
      const status = String(body.status || "draft");
      const rawModelOverride = body.modelOverride ? String(body.modelOverride) : "";
      const executionWindowMinutes = Number(body.executionWindowMinutes) || 30;
      const sessionTarget = body.sessionTarget === "main" ? "main" : "isolated";
      // notify_chat_id: where to send completion/failure reports. Empty = owner's private DM.
      const notifyChatId = body.notifyChatId ? String(body.notifyChatId).trim() || null : null;
      // Persist the selected override even for main-session events so the value is
      // available if the event is later switched back to isolated mode. It is only
      // applied when the run executes as an isolated agentTurn.
      const modelOverride = rawModelOverride;
      const processVersionIds: string[] = Array.isArray(body.processVersionIds)
        ? body.processVersionIds.map(String)
        : [];

      if (!title) return fail("Title is required.");
      if (!startsAt || isNaN(startsAt.getTime())) return fail("Valid start date is required.");
      // Allow a 5-minute grace period — user picks a time, goes through the wizard,
      // and by the time they submit it may be a few minutes past the selected time.
      // If within grace window, bump to now so the scheduler executes it immediately.
      const PAST_GRACE_MS = 5 * 60 * 1000;
      const now = new Date();
      let bumpedToNow = false;
      if (startsAt.getTime() < now.getTime() - PAST_GRACE_MS) return fail("Cannot create events in the past.");
      if (startsAt < now) {
        // Within grace window — keep the user's exact chosen timestamp (seconds=0, ms=0 from Luxon).
        // The scheduler detects past timestamps and fires them immediately via --at 1s.
        // Do NOT overwrite with raw Date.now() — that would corrupt the minute value
        // (e.g. user picked 8:45 but raw now() is 8:44:50 → stored as 8:44 instead of 8:45).
        bumpedToNow = true;
      }

      // Resolve scheduling interval: body override (dev/test) → DB setting → default 15
      const timeStepMinutes = await (async () => {
        if (body.timeStepMinutes !== undefined) return Math.max(0, Math.floor(Number(body.timeStepMinutes)));
        const [ws] = await sql`SELECT scheduling_interval_minutes FROM worker_settings WHERE id = 1 LIMIT 1`;
        return Number(ws?.scheduling_interval_minutes ?? 15);
      })();

      // When timeStepMinutes > 0, enforce alignment + unique slot
      if (timeStepMinutes > 0) {
        if (startsAt.getMinutes() % timeStepMinutes !== 0) {
          return fail(`Events can only be scheduled at ${timeStepMinutes}-minute intervals.`);
        }

        const slotStart = new Date(startsAt);
        slotStart.setSeconds(0, 0);
        const slotEnd = new Date(slotStart.getTime() + timeStepMinutes * 60 * 1000);
        const [conflict] = await sql`
          SELECT id, title FROM agenda_events
          WHERE workspace_id = ${wid}
            AND status IN ('active', 'draft')
            AND starts_at >= ${slotStart}
            AND starts_at < ${slotEnd}
          LIMIT 1
        `;
        if (conflict) {
          return fail(`Time slot already taken by "${conflict.title}". Events must be at least ${timeStepMinutes} minutes apart.`);
        }
      }
      // When timeStepMinutes === 0: free time mode — no alignment or slot checks

      const [event] = await sql`
        insert into agenda_events (
          workspace_id, title, free_prompt, default_agent_id,
          timezone, starts_at, ends_at, recurrence_rule, recurrence_until, status,
          model_override, execution_window_minutes, session_target, notify_chat_id, created_by
        ) values (
          ${wid}, ${title}, ${freePrompt}, ${agentId},
          ${timezone}, ${startsAt}, ${endsAt}, ${recurrenceRule}, ${recurrenceUntil}, ${status},
          ${modelOverride}, ${executionWindowMinutes}, ${sessionTarget}, ${notifyChatId},
          ${body.createdBy ? String(body.createdBy) : null}
        )
        returning *
      `;

      // Attach processes
      for (let i = 0; i < processVersionIds.length; i++) {
        await sql`
          insert into agenda_event_processes (agenda_event_id, process_version_id, sort_order)
          values (${event.id}, ${processVersionIds[i]}, ${i})
        `;
      }

      // If a one-time active event is created in the past, mark it needs_retry immediately.
      let autoNeedsRetry = false;
      const autoNeedsRetryReason = "Start time is already in the past for an active one-time event; occurrence was auto-marked as needs_retry.";
      if (status === "active" && !recurrenceRule && !bumpedToNow && startsAt < new Date()) {
        const [occurrence] = await sql`
          insert into agenda_occurrences (agenda_event_id, scheduled_for, status)
          values (${event.id}, ${startsAt}, 'needs_retry')
          on conflict (agenda_event_id, scheduled_for) do update
            set status = 'needs_retry'
          returning id
        `;
        await sql`
          insert into agenda_run_attempts (occurrence_id, attempt_no, status, started_at, finished_at, summary, error_message)
          values (${occurrence.id}, 1, 'failed', now(), now(), ${autoNeedsRetryReason}, ${autoNeedsRetryReason})
          on conflict do nothing
        `;
        await sql`
          update agenda_occurrences set latest_attempt_no = 1 where id = ${occurrence.id}
        `;
        autoNeedsRetry = true;
      }

      // Notify SSE clients
      await sql`select pg_notify('agenda_change', ${JSON.stringify({ action: "create", eventId: event.id })})`;

      return ok({
        event,
        autoNeedsRetry,
        warning: autoNeedsRetry ? autoNeedsRetryReason : null,
      });
    }

    // ── Test-only actions — blocked in production ────────────────────────────
    if (typeof action === "string" && action.startsWith("testOnly")) {
      if (process.env.NODE_ENV === "production") {
        return fail("Not available in production", 403);
      }
    }

    // ── Test-only: directly create a needs_retry occurrence ─────────────────
    // Used by automated tests to create a needs_retry occurrence without needing
    // the scheduler to run, or without triggering the full failure/cleanup cycle.
    if (action === "testOnlyCreateNeedsRetryOccurrence") {
      const eventId = String(body.eventId ?? "");
      const scheduledFor = String(body.scheduledFor ?? "");
      if (!eventId) return fail("eventId is required", 400);
      if (!scheduledFor) return fail("scheduledFor is required", 400);

      const [event] = await sql`
        select id from agenda_events where id = ${eventId} limit 1
      `;
      if (!event) return fail("Event not found", 404);

      // Create a needs_retry occurrence directly
      const [occ] = await sql`
        insert into agenda_occurrences
          (agenda_event_id, scheduled_for, status, latest_attempt_no)
        values
          (${eventId}, ${new Date(scheduledFor)}, 'needs_retry', 1)
        on conflict (agenda_event_id, scheduled_for) do update
          set status = 'needs_retry', latest_attempt_no = 1
        returning id, scheduled_for, status
      `;

      await sql`select pg_notify('agenda_change', ${JSON.stringify({ action: "test_create", eventId })})`;
      return ok({ occurrenceId: occ.id, status: occ.status, scheduledFor: occ.scheduled_for });
    }

    // ── Test-only: directly create a scheduled occurrence ─────────────────────
    // Used by automated tests to have an occurrence ready without needing the scheduler.
    if (action === "testOnlyCreateScheduledOccurrence") {
      const eventId = String(body.eventId ?? "");
      const scheduledFor = String(body.scheduledFor ?? new Date().toISOString());
      if (!eventId) return fail("eventId is required", 400);

      const [event] = await sql`
        select id from agenda_events where id = ${eventId} limit 1
      `;
      if (!event) return fail("Event not found", 404);

      const [occ] = await sql`
        insert into agenda_occurrences
          (agenda_event_id, scheduled_for, status, latest_attempt_no)
        values
          (${eventId}, ${new Date(scheduledFor)}, 'scheduled', 0)
        on conflict (agenda_event_id, scheduled_for) do nothing
        returning id, scheduled_for, status
      `;

      if (!occ) {
        // Already exists — return existing
        const [existing] = await sql`
          select id, scheduled_for, status from agenda_occurrences
          where agenda_event_id = ${eventId} and scheduled_for = ${new Date(scheduledFor)}
        `;
        if (existing) return ok({ occurrenceId: existing.id, status: existing.status, scheduledFor: existing.scheduled_for });
        return fail("Failed to create occurrence (conflict)", 409);
      }

      await sql`select pg_notify('agenda_change', ${JSON.stringify({ action: "test_create", eventId })})`;
      return ok({ occurrenceId: occ.id, status: occ.status, scheduledFor: occ.scheduled_for });
    }

    // ── Test-only: inject a completed run with a PDF artifact ───────────────────
    // Creates a succeeded run_attempt + run_step with a fake PDF artifact payload.
    // Used to test that PDF attachments are visible in the event/occurrence details.
    if (action === "testOnlyInjectRunWithPdf") {
      const eventId = String(body.eventId ?? "");
      const occurrenceId = String(body.occurrenceId ?? "");
      if (!eventId || !occurrenceId) return fail("eventId and occurrenceId are required", 400);

      const [occ] = await sql`
        select id from agenda_occurrences where id = ${occurrenceId} and agenda_event_id = ${eventId} limit 1
      `;
      if (!occ) return fail("Occurrence not found", 404);

      // Mark occurrence as succeeded
      await sql`
        update agenda_occurrences set status = 'succeeded' where id = ${occurrenceId}
      `;

      // Create a succeeded run attempt
      const [attempt] = await sql`
        insert into agenda_run_attempts (occurrence_id, attempt_no, status, started_at, finished_at, summary)
        values (${occurrenceId}, 1, 'succeeded', now() - interval '10 seconds', now(), 'Test run completed')
        returning id
      `;

      // Create a run step with a fake PDF artifact
      const artifactPayload = JSON.stringify({
        files: [{
          name: "test-report.pdf",
          mimeType: "application/pdf",
          path: "/tmp/test-report.pdf",
          size: 4096,
        }],
      });

      await sql`
        insert into agenda_run_steps
          (run_attempt_id, step_order, status, started_at, finished_at, artifact_payload)
        values (${attempt.id}, 1, 'succeeded', now() - interval '8 seconds', now() - interval '1 second', ${artifactPayload}::jsonb)
      `;

      return ok({ runAttemptId: attempt.id, artifact: "test-report.pdf" });
    }

    // ── Test-only: check if a file exists at a given path ───────────────────
    if (action === "testOnlyCheckFileExists") {
      const filePath = String(body.path ?? "");
      if (!filePath) return fail("path is required", 400);
      try {
        const { stat } = await import("node:fs/promises");
        const s = await stat(filePath);
        return ok({ exists: s.isFile(), size: s.size });
      } catch {
        return ok({ exists: false });
      }
    }

    return fail(`Unsupported action: ${action}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Agenda event operation failed", 500);
  }
}
