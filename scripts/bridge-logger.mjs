#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import os from "node:os";
import postgres from "postgres";

import { getOccurrenceArtifactDir, scanArtifactDirRecursive } from "./runtime-artifacts.mjs";

const WORKSPACE_ROOT = path.resolve(path.join(import.meta.dirname, ".."));
const STATE_DIR = path.join(WORKSPACE_ROOT, ".runtime", "bridge-logger");
const OFFSETS_PATH = path.join(STATE_DIR, "offsets.json");
const DEAD_LETTER_PATH = path.join(STATE_DIR, "dead-letter.jsonl");
const LOCK_PATH = path.join(STATE_DIR, "bridge-logger.lock");

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const AGENTS_DIR = path.join(OPENCLAW_HOME, "agents");
const GATEWAY_LOG_DIR = "/tmp/openclaw";
const CRON_RUNS_DIR = path.join(OPENCLAW_HOME, "cron", "runs");

const SCAN_INTERVAL_MS = 5000;
const DEAD_LETTER_REPLAY_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 45000;
const BL_SERVICE_NAME = "bridge-logger";
const DEDUPE_WINDOW_MS = 30000;

const dedupeMap = new Map();
const watched = new Set();
const offsets = new Map();
let stateDirty = false;
let replayInFlight = false;

function isConnectionEndedError(error) {
  const message = String(error?.message || error || "");
  return message.includes("CONNECTION_ENDED") || message.includes("write CONNECTION_ENDED");
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function acquireLockOrExit() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const raw = fs.readFileSync(LOCK_PATH, "utf8").trim();
      // Lock file format: "pid:startTimeMs"
      const colonIdx = raw.indexOf(":");
      if (colonIdx > 0) {
        const previousPid = Number(raw.slice(0, colonIdx));
        const previousStartMs = Number(raw.slice(colonIdx + 1));
        if (Number.isFinite(previousPid) && previousPid > 0 && Number.isFinite(previousStartMs)) {
          // PID collision with a very recent timestamp → likely a real concurrent instance
          const now = Date.now();
          const isRecent = (now - previousStartMs) < 30_000; // within 30s
          if (previousPid !== process.pid && isRecent) {
            console.error(`[bridge-logger] another instance is already running (pid=${previousPid}). Exiting.`);
            process.exit(1);
          }
          // Stale lock (different PID or old timestamp from a previous run) — continue to overwrite
        }
      }
    }
    fs.writeFileSync(LOCK_PATH, `${process.pid}:${Date.now()}`);
  } catch (error) {
    console.error("[bridge-logger] failed to acquire lock:", error?.message || error);
    process.exit(1);
  }
}

function releaseLock() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return;
    const raw = fs.readFileSync(LOCK_PATH, "utf8").trim();
    const colonIdx = raw.indexOf(":");
    const current = colonIdx > 0 ? raw.slice(0, colonIdx) : raw;
    if (current === String(process.pid)) fs.unlinkSync(LOCK_PATH);
  } catch {
    // ignore lock release errors
  }
}

function loadOffsets() {
  try {
    if (!fs.existsSync(OFFSETS_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(OFFSETS_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return;
    for (const [k, v] of Object.entries(parsed)) {
      if (Number.isFinite(v)) offsets.set(k, Number(v));
    }
  } catch {
    // ignore malformed offsets
  }
}

function flushOffsets() {
  if (!stateDirty) return;
  stateDirty = false;
  const out = {};
  for (const [k, v] of offsets.entries()) out[k] = v;
  fs.writeFileSync(OFFSETS_PATH, JSON.stringify(out, null, 2));
}

function setOffset(filePath, value) {
  offsets.set(filePath, Math.max(0, Number(value) || 0));
  stateDirty = true;
}

function getOffset(filePath) {
  const value = offsets.get(filePath);
  return Number.isFinite(value) ? Number(value) : null;
}

function listSessionFiles() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  const files = [];
  for (const agentId of fs.readdirSync(AGENTS_DIR)) {
    const sessionsDir = path.join(AGENTS_DIR, agentId, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    for (const f of fs.readdirSync(sessionsDir)) {
      if (f.endsWith(".jsonl")) files.push(path.join(sessionsDir, f));
    }
  }
  return files;
}

function parseSessionMeta(filePath) {
  const sessionsDir = path.dirname(filePath);
  const agentDir = path.dirname(sessionsDir);
  const runtimeAgentId = path.basename(agentDir);
  const sessionKey = path.basename(filePath, ".jsonl");
  return { runtimeAgentId, sessionKey };
}

function listGatewayFiles() {
  if (!fs.existsSync(GATEWAY_LOG_DIR)) return [];
  return fs
    .readdirSync(GATEWAY_LOG_DIR)
    .filter((name) => name.startsWith("openclaw-") && name.endsWith(".log"))
    .map((name) => path.join(GATEWAY_LOG_DIR, name));
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeRecord(raw) {
  const nested = raw?.message && typeof raw.message === "object" ? raw.message : raw;
  return {
    role: String(nested?.role || raw?.role || "").toLowerCase(),
    text: String(nested?.text || raw?.text || nested?.message || raw?.message || ""),
    runId: String(nested?.run_id || raw?.run_id || nested?.id || raw?.id || ""),
    sourceMessageId: String(nested?.message_id || raw?.message_id || nested?.id || raw?.id || ""),
    eventType: String(nested?.event_type || raw?.event_type || nested?.eventType || raw?.eventType || ""),
    model: String(nested?.model || raw?.model || ""),
    toolCalls: Array.isArray(nested?.toolCalls) ? nested.toolCalls : Array.isArray(raw?.toolCalls) ? raw.toolCalls : [],
    raw,
  };
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isErrorLike(text) {
  const t = String(text || "").toLowerCase();
  // Operational messages that contain "error"/"fail" but are NOT actual errors
  const safePatterns = [
    "error backoff",       // cron recovery — normal
    "failover decision",   // embedded run failover — normal
    "agent end",           // embedded run end — normal
    "backoff applied",     // retry backoff — normal
    "error_count",         // metric field name
    "error_rate",          // metric field name
    "on_error",            // config/handler name
    "retry after",         // recovery message
  ];
  if (safePatterns.some((p) => t.includes(p))) return false;
  return ["error", "failed", "exception", "timeout", "permission denied", "unauthorized"].some((x) => t.includes(x));
}

function hasMemoryHints(text) {
  const t = String(text || "").toLowerCase();
  return ["memory", "qdrant", "vector", "embedding", "memory_store", "memory_search"].some((x) => t.includes(x));
}

function inferMemoryEvent(text, status = "success") {
  const t = String(text || "").toLowerCase();
  if (status === "error" || isErrorLike(t)) return "memory.error";
  if (t.includes("search") || t.includes("query") || t.includes("recall")) return "memory.search";
  if (t.includes("upsert") || t.includes("insert") || t.includes("persist")) return "memory.upsert";
  if (t.includes("write") || t.includes("save") || t.includes("append") || t.includes("update")) return "memory.write";
  return "memory.read";
}

function preview(text) {
  const t = cleanText(text);
  return t.length > 240 ? `${t.slice(0, 239)}…` : t;
}

function inferChannelTypeFromText(text) {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("telegram")) return "telegram";
  if (lower.includes("gateway") || lower.includes("websocket") || lower.includes("ws://")) return "gateway";
  if (lower.includes("qdrant") || lower.includes("vector") || lower.includes("embedding")) return "qdrant";
  return "internal";
}

function shouldEmit(key) {
  const now = Date.now();
  for (const [k, ts] of dedupeMap.entries()) {
    if (now - ts > DEDUPE_WINDOW_MS) dedupeMap.delete(k);
  }
  if (dedupeMap.has(key)) return false;
  dedupeMap.set(key, now);
  return true;
}

function appendDeadLetter(row, error) {
  const line = JSON.stringify({ at: new Date().toISOString(), error: String(error || "insert failed"), row });
  fs.appendFileSync(DEAD_LETTER_PATH, `${line}\n`);
}

async function replayDeadLetters(sql) {
  if (replayInFlight || !fs.existsSync(DEAD_LETTER_PATH)) return;
  replayInFlight = true;
  try {
    const lines = fs.readFileSync(DEAD_LETTER_PATH, "utf8").split(/\r?\n/).filter(Boolean);
    if (!lines.length) return;
    const keep = [];
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      const row = parsed?.row;
      if (!row) continue;
      try {
        await insertLogRow(sql, row);
      } catch {
        keep.push(line);
      }
    }
    if (!keep.length) fs.unlinkSync(DEAD_LETTER_PATH);
    else fs.writeFileSync(DEAD_LETTER_PATH, `${keep.join("\n")}\n`);
  } finally {
    replayInFlight = false;
  }
}

async function getWorkspaceId(sql) {
  const rows = await sql`select id from workspaces order by created_at asc limit 1`;
  return rows[0]?.id || null;
}

async function ensureAgent(sql, workspaceId, runtimeAgentId, model = "") {
  // Pure upsert — no race window between SELECT and INSERT
  const result = await sql`
    insert into agents (workspace_id, openclaw_agent_id, status, model, last_heartbeat_at)
    values (${workspaceId}, ${runtimeAgentId}, 'running', ${model || null}, now())
    on conflict (workspace_id, openclaw_agent_id) do update
      set status = 'running',
          model = coalesce(${model || null}, agents.model),
          last_heartbeat_at = now(),
          updated_at = now()
    returning id
  `;
  return result[0]?.id;
}

async function insertLogRow(sql, row) {
  const existing = await sql`
    select id
    from agent_logs
    where runtime_agent_id = ${row.runtime_agent_id}
      and coalesce(event_type, '') = ${row.event_type || ''}
      and coalesce(message_preview, '') = ${row.message_preview || ''}
      and occurred_at > now() - interval '8 seconds'
    limit 1
  `;
  if (existing[0]?.id) return;

  const inserted = await sql`
    insert into agent_logs (
      workspace_id, agent_id, runtime_agent_id, occurred_at, level, type, run_id, message, event_type,
      direction, channel_type, session_key, source_message_id, correlation_id, status, retry_count,
      message_preview, is_json, contains_pii, memory_source, memory_key, collection, query_text,
      result_count, raw_payload
    ) values (
      ${row.workspace_id}, ${row.agent_id}, ${row.runtime_agent_id}, now(),
      ${row.level}, ${row.type}, ${row.run_id || null}, ${row.message || null}, ${row.event_type || null},
      ${row.direction || null}, ${row.channel_type || null}, ${row.session_key || null}, ${row.source_message_id || null},
      ${row.correlation_id || null}, ${row.status || null}, ${row.retry_count ?? 0}, ${row.message_preview || null},
      ${row.is_json ?? false}, ${row.contains_pii ?? false}, ${row.memory_source || null}, ${row.memory_key || null},
      ${row.collection || null}, ${row.query_text || null}, ${row.result_count ?? null}, ${row.raw_payload || null}
    ) returning id::text
  `;

  const insertedId = inserted[0]?.id || "";
  if (insertedId) {
    await sql`select pg_notify('agent_logs', ${insertedId})`;
  }
}

async function emitLog(sql, ctx, payload) {
  const dedupeKey = `${ctx.runtimeAgentId}|${ctx.sessionKey}|${payload.event_type}|${payload.message_preview}`;
  if (!shouldEmit(dedupeKey)) return;

  const row = {
    workspace_id: ctx.workspaceId,
    agent_id: ctx.agentDbId,
    runtime_agent_id: ctx.runtimeAgentId,
    session_key: `agent:${ctx.runtimeAgentId}:${ctx.sessionKey}`,
    source_message_id: payload.source_message_id || "",
    correlation_id: payload.correlation_id || payload.run_id || payload.source_message_id || "",
    ...payload,
  };

  try {
    await insertLogRow(sql, row);
  } catch (error) {
    appendDeadLetter(row, error?.message || String(error));
  }
}

async function handleToolCalls(sql, ctx, toolCalls, runId) {
  for (const call of toolCalls || []) {
    const name = cleanText(call?.name || call?.tool || "unknown_tool");
    const statusRaw = cleanText(call?.status || call?.state || call?.outcome || "started").toLowerCase();
    const status = statusRaw.includes("error") || statusRaw.includes("fail") ? "error" : statusRaw.includes("success") || statusRaw.includes("done") ? "success" : "started";
    const probe = `${name} ${JSON.stringify(call?.arguments || {})} ${JSON.stringify(call?.result || {})}`.toLowerCase();
    const isMemory = hasMemoryHints(probe) || name.includes("memory") || name.includes("qdrant") || name.includes("vector");
    const eventType = isMemory ? inferMemoryEvent(probe, status) : status === "error" ? "tool.error" : status === "started" ? "tool.start" : "tool.success";

    await emitLog(sql, ctx, {
      level: status === "error" ? "error" : "info",
      type: isMemory ? "memory" : "tool",
      run_id: runId,
      event_type: eventType,
      direction: "internal",
      channel_type: probe.includes("qdrant") || probe.includes("vector") ? "qdrant" : "internal",
      status,
      message: `Tool ${name} (${status}) ${preview(JSON.stringify(call?.arguments || {}))}`,
      message_preview: preview(`Tool ${name} (${status}) ${JSON.stringify(call?.arguments || {})}`),
      source_message_id: cleanText(call?.id || ""),
      memory_source: isMemory ? (probe.includes("qdrant") ? "qdrant_vector" : "session") : null,
      memory_key: cleanText(call?.id || ""),
      collection: cleanText(call?.arguments?.collection || call?.collection || ""),
      query_text: cleanText(call?.arguments?.query || call?.arguments?.text || ""),
      result_count: Number.isFinite(call?.result_count) ? call.result_count : null,
      raw_payload: call,
      is_json: true,
      contains_pii: false,
    });
  }
}

async function handleGatewayLine(sql, filePath, line) {
  const raw = cleanText(line);
  if (!raw) return;

  const workspaceId = await getWorkspaceId(sql);
  if (!workspaceId) return;

  const runtimeAgentId = "main";
  const agentDbId = await ensureAgent(sql, workspaceId, runtimeAgentId, "");
  if (!agentDbId) return;

  const lower = raw.toLowerCase();
  const isError = isErrorLike(lower);
  const isTool = lower.includes("tool") || lower.includes("function_call") || lower.includes("call_");
  const isMemory = hasMemoryHints(lower);

  let eventType = "system.warning";
  let type = "system";
  let level = isError ? "error" : "info";

  if (isMemory) {
    type = "memory";
    eventType = inferMemoryEvent(lower, isError ? "error" : "success");
  } else if (isTool) {
    type = "tool";
    eventType = isError ? "tool.error" : "tool.success";
  } else if (lower.includes("startup") || lower.includes("started")) {
    eventType = "system.startup";
  } else if (lower.includes("shutdown") || lower.includes("stopped")) {
    eventType = "system.shutdown";
  } else if (isError) {
    eventType = "system.error";
  }

  await emitLog(sql, {
    workspaceId,
    agentDbId,
    runtimeAgentId,
    sessionKey: `gateway:${path.basename(filePath)}`,
  }, {
    level,
    type,
    run_id: "",
    event_type: eventType,
    direction: "internal",
    channel_type: isMemory ? "qdrant" : "gateway",
    message: raw,
    message_preview: preview(raw),
    source_message_id: "",
    raw_payload: { source: path.basename(filePath), line: raw },
    is_json: false,
    contains_pii: false,
    memory_source: isMemory ? (lower.includes("qdrant") ? "qdrant_vector" : "session") : null,
    retry_count: 0,
  });
}

async function handleSessionLine(sql, filePath, line) {
  const parsed = parseJsonLine(line);
  if (!parsed) return;

  const normalized = normalizeRecord(parsed);
  const { runtimeAgentId, sessionKey } = parseSessionMeta(filePath);
  if (!runtimeAgentId || !sessionKey) return;

  const workspaceId = await getWorkspaceId(sql);
  if (!workspaceId) return;
  const agentDbId = await ensureAgent(sql, workspaceId, runtimeAgentId, normalized.model);
  if (!agentDbId) return;

  const ctx = { workspaceId, agentDbId, runtimeAgentId, sessionKey };

  const role = normalized.role;
  const text = cleanText(normalized.text);
  const runId = normalized.runId || "";
  const sourceMessageId = normalized.sourceMessageId || "";
  const explicitEventType = normalized.eventType || "";

  if (text) {
    let eventType = "system.warning";
    let type = "system";
    let level = "info";
    let direction = "internal";
    let channelType = inferChannelTypeFromText(text);

    if (explicitEventType.startsWith("chat.") || explicitEventType.startsWith("tool.") || explicitEventType.startsWith("memory.") || explicitEventType.startsWith("system.") || explicitEventType.startsWith("heartbeat.")) {
      eventType = explicitEventType;
      if (explicitEventType.startsWith("chat.")) {
        type = "workflow";
        direction = explicitEventType === "chat.user_in" ? "inbound" : "outbound";
      } else if (explicitEventType.startsWith("tool.")) {
        type = "tool";
      } else if (explicitEventType.startsWith("memory.")) {
        type = "memory";
      } else {
        type = "system";
      }
      if (explicitEventType.endsWith("error")) level = "error";
    } else
    if (role === "assistant") {
      eventType = "chat.assistant_out";
      type = "workflow";
      direction = "outbound";
    } else if (role === "user") {
      eventType = "chat.user_in";
      type = "workflow";
      direction = "inbound";
      if (channelType === "internal") channelType = "telegram";
    } else if (role.includes("tool")) {
      type = "tool";
      eventType = isErrorLike(text) ? "tool.error" : "tool.success";
      level = isErrorLike(text) ? "error" : "info";
    } else if (hasMemoryHints(text)) {
      type = "memory";
      eventType = inferMemoryEvent(text, isErrorLike(text) ? "error" : "success");
      channelType = text.toLowerCase().includes("qdrant") ? "qdrant" : "internal";
      level = isErrorLike(text) ? "error" : "info";
    } else {
      eventType = isErrorLike(text) ? "system.error" : "system.warning";
      type = "system";
      level = isErrorLike(text) ? "error" : "warning";
    }

    await emitLog(sql, ctx, {
      level,
      type,
      run_id: runId,
      event_type: eventType,
      direction,
      channel_type: channelType,
      message: text,
      message_preview: preview(text),
      source_message_id: sourceMessageId,
      raw_payload: normalized.raw,
      is_json: false,
      contains_pii: false,
      memory_source: type === "memory" ? (channelType === "qdrant" ? "qdrant_vector" : "session") : null,
      retry_count: 0,
    });
  }

  if (normalized.toolCalls?.length) {
    await handleToolCalls(sql, ctx, normalized.toolCalls, runId);
  }
}

function tailFile(getSql, onDbReset, filePath, handler, startFromBeginning = false) {
  if (watched.has(filePath)) return;
  watched.add(filePath);

  let pos = 0;
  let draining = false;
  let pending = false;

  const drain = () => {
    if (draining) {
      pending = true;
      return;
    }
    draining = true;
    fs.stat(filePath, (err, stat) => {
      if (err) {
        draining = false;
        return;
      }
      if (stat.size < pos) pos = 0;
      if (stat.size === pos) {
        draining = false;
        if (pending) {
          pending = false;
          drain();
        }
        return;
      }

      const end = stat.size;
      const stream = fs.createReadStream(filePath, { start: pos, end });
      const rl = readline.createInterface({ input: stream });
      rl.on("line", (line) => {
        handler(getSql(), filePath, line).catch((e) => {
          if (isConnectionEndedError(e)) {
            console.warn("[bridge-logger] DB connection ended during line processing; reconnecting...");
            onDbReset();
            return;
          }
          console.error("[bridge-logger] line error:", e?.message || e);
        });
      });
      rl.on("close", () => {
        pos = end;
        setOffset(filePath, pos);
        draining = false;
        if (pending) {
          pending = false;
          drain();
        }
      });
    });
  };

  fs.stat(filePath, (err, stat) => {
    if (err) return;
    const offset = getOffset(filePath);
    if (offset == null) {
      if (startFromBeginning) {
        // Cron run files: always read from the start — the result is already in the file
        pos = 0;
        setOffset(filePath, 0);
        drain();
      } else {
        // Session/gateway files: skip existing content on first encounter
        pos = stat.size;
        setOffset(filePath, pos);
      }
      return;
    }
    pos = Math.min(offset, stat.size);
    if (stat.size > pos) drain();
  });

  try {
    // Use polling-based watch for better compatibility (avoid "illegal path" errors with inotify)
    fs.watchFile(filePath, { interval: 1000 }, () => drain());
  } catch (error) {
    console.error(`[bridge-logger] fs.watchFile failed for ${filePath}:`, error?.message || error);
  }
}

async function heartbeat(sql) {
  const workspaceId = await getWorkspaceId(sql);
  if (!workspaceId) return;
  const rows = await sql`select id from agents where workspace_id=${workspaceId}`;
  for (const row of rows) {
    await sql`update agents set last_heartbeat_at=now(), updated_at=now() where id=${row.id}`;
  }
}

// ── Cron run JSONL watcher ───────────────────────────────────────────────────
// Watches ~/.openclaw/cron/runs/<jobId>.jsonl for new lines.
// Each line is a finished cron run. On completion we:
//   1. Write agenda_run_attempts + agenda_run_steps so the Output tab works.
//   2. pg_notify('agenda_change') so the calendar updates instantly.
//   3. Trigger Qdrant cleanup for failed sessions.
// This replaces the scheduler's polling-based syncCronRunResults() entirely.

function listCronRunFiles() {
  if (!fs.existsSync(CRON_RUNS_DIR)) return [];
  return fs
    .readdirSync(CRON_RUNS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(CRON_RUNS_DIR, f));
}

/** Parse jobId from the file path: ~/.openclaw/cron/runs/<jobId>.jsonl */
function cronJobIdFromPath(filePath) {
  return path.basename(filePath, ".jsonl");
}

/**
 * Find the session file path for a given session target.
 * - For 'isolated': sessionId is the UUID from run.sessionId
 * - For 'main': look up agent:main:main in sessions.json to get the session file
 * Returns null if the session cannot be resolved.
 */
async function resolveSessionFile(sessionTarget, sessionId) {
  if (sessionTarget === 'main') {
    try {
      const sessionsFile = path.join(OPENCLAW_HOME, 'agents', 'main', 'sessions', 'sessions.json');
      const raw = fs.readFileSync(sessionsFile, 'utf8');
      const sessions = JSON.parse(raw);
      const mainEntry = sessions['agent:main:main'];
      if (!mainEntry?.sessionFile) {
        console.log(`[bridge-logger] resolveSessionFile: agent:main:main not found in sessions.json`);
        return null;
      }
      const sessionFilePath = mainEntry.sessionFile;
      console.log(`[bridge-logger] resolveSessionFile: agent:main:main → ${path.basename(sessionFilePath)} (status=${mainEntry.status})`);
      return sessionFilePath;
    } catch (err) {
      console.log(`[bridge-logger] resolveSessionFile: sessions.json read error: ${err.message}`);
      return null;
    }
  }
  // Isolated: sessionId is the UUID
  if (sessionId) {
    return path.join(OPENCLAW_HOME, 'agents', 'main', 'sessions', `${sessionId}.jsonl`);
  }
  return null;
}

/**
 * Read the last assistant message from a session JSONL file.
 * Used for main session runs where run.summary is the rendered prompt (input),
 * not the agent's actual output.
 *
 * For 'main' sessions: resolves via sessions.json → agent:main:main → sessionFile
 * For 'isolated' sessions: uses the sessionId from run.sessionId
 *
 * Returns the text content of the last assistant turn, or null if unreadable.
 */
async function readLastAssistantFromSession(sessionTarget, sessionId, fromLineOffset = null, occurrenceId = null) {
  if (!sessionTarget) return null;
  const sessionFilePath = await resolveSessionFile(sessionTarget, sessionId);
  if (!sessionFilePath) {
    console.log(`[bridge-logger] readLastAssistantFromSession: no session file resolved for ${sessionTarget}/${sessionId}`);
    return null;
  }
  try {
    const raw = fs.readFileSync(sessionFilePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);

    // Determine the starting index for the scan.
    // fromLineOffset is the line count BEFORE the task was injected.
    // We scan FORWARD from this point to find the NEXT assistant message —
    // which is this task's own output, not the last message from a previous task.
    // This avoids the backward-scan contamination problem entirely.
    const startIdx = fromLineOffset != null ? Math.max(0, fromLineOffset) : 0;

    if (startIdx >= lines.length) {
      console.log(`[bridge-logger] readLastAssistantFromSession: fromLineOffset=${fromLineOffset} >= total lines=${lines.length} in ${path.basename(sessionFilePath)} — nothing to scan`);
      return null;
    }

    // ── Marker-based scan for main-session tasks ─────────────────────────────────
    // When occurrenceId is provided, find the [AGENDA_MARKER:occurrence_id=...] line
    // that marks where this task was injected. This gives us the precise injection
    // point regardless of session growth between scheduling and firing times.
    // The marker appears as a user message line in the session file.
    let injectionLineIdx = null;
    if (occurrenceId) {
      const markerPattern = `# AGENDA_MARKER:occurrence_id=${occurrenceId}`;
      // Scan backward from end to find the most recent marker for this occurrence.
      // This correctly handles the case where multiple tasks are pending:
      // the most recent marker in the file belongs to the most recently fired task.
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          const content = parsed?.message?.content || parsed?.content || '';
          const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => typeof c === 'string' ? c : c?.text || '').join('') : '';
          if (text.includes(markerPattern)) {
            injectionLineIdx = i;
            console.log(`[bridge-logger] readLastAssistantFromSession: marker found at line ${i+1} for occurrence ${occurrenceId}`);
            break;
          }
        } catch { continue; }
      }
      if (injectionLineIdx === null) {
        console.warn(`[bridge-logger] readLastAssistantFromSession: marker not found for occurrence ${occurrenceId} — widening scan to last 200 lines`);
        // ── Safety net: if marker not found, scan the last 200 lines of the session file.
        // The marker can be lost if the session file was truncated or rotated between
        // scheduling and firing. The assistant still wrote output somewhere.
        const tailStart = Math.max(0, lines.length - 200);
        for (let i = tailStart; i < lines.length; i++) {
          try {
            const parsed = JSON.parse(lines[i]);
            const role = parsed?.role ?? parsed?.message?.role ?? '';
            if (role !== 'assistant') continue;
            const content = parsed?.content ?? parsed?.message?.content ?? '';
            const text = extractContentText(content);
            if (text.trim()) {
              console.log(`[bridge-logger] readLastAssistantFromSession: found assistant in tail scan (${text.trim().length} chars) for occurrence ${occurrenceId}`);
              return text.trim().slice(0, 8000);
            }
          } catch { continue; }
        }
        console.warn(`[bridge-logger] readLastAssistantFromSession: no output in tail scan either for occurrence ${occurrenceId} — falling back to fromLineOffset=${fromLineOffset}`);
      }
    }

    // Use marker position if found, otherwise fall back to fromLineOffset
    const scanStartIdx = injectionLineIdx !== null ? injectionLineIdx : startIdx;

    // Scan FORWARD from the injection point to find this task's assistant response.
    // The first assistant message AFTER the marker (or fromLineOffset) is the task's output.
    for (let i = scanStartIdx; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        const role = parsed?.role ?? parsed?.message?.role ?? '';
        if (role !== 'assistant') continue;
        // Found an assistant message after the task injection — this is the task's output.
        const content = parsed?.content ?? parsed?.message?.content ?? '';
        const text = extractContentText(content);
        if (text.trim()) {
          console.log(`[bridge-logger] readLastAssistantFromSession: found assistant msg (${text.trim().length} chars) in ${path.basename(sessionFilePath)} at line ${i+1} (markerLine=${injectionLineIdx !== null} scanStart=${scanStartIdx})`);
          return text.trim().slice(0, 8000);
        }
        // Empty assistant message — check for an error (e.g. rate-limit, model error).
        // If errorMessage is present, surface it as a special sentinel so the caller
        // can report the real failure reason instead of a generic no_output.
        const errMsg = parsed?.message?.errorMessage ?? parsed?.errorMessage ?? null;
        if (errMsg) {
          console.warn(`[bridge-logger] readLastAssistantFromSession: assistant error at line ${i+1} for occurrence ${occurrenceId}: ${errMsg}`);
          return `__SESSION_ERROR__:${errMsg}`;
        }
        // Empty assistant message with no error — keep scanning.
      } catch { continue; }
    }
    console.log(`[bridge-logger] readLastAssistantFromSession: no assistant message found in ${path.basename(sessionFilePath)} (marker=${injectionLineIdx !== null}, fromLineOffset=${fromLineOffset}) — task produced no output`);
  } catch (err) {
    console.log(`[bridge-logger] readLastAssistantFromSession: session file error: ${err.message}`);
  }
  return null;
}

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') {
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
    }
    return '';
  }).join('');
}

function normalizeComparableText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
}

function looksLikePromptEcho(candidate, renderedPrompt, summaryText) {
  const candidateNorm = normalizeComparableText(candidate);
  if (!candidateNorm) return true;
  const promptNorm = normalizeComparableText(renderedPrompt);
  const summaryNorm = normalizeComparableText(summaryText);
  // Exact match with either the rendered prompt or the cron summary
  if (promptNorm && candidateNorm === promptNorm) return true;
  if (summaryNorm && candidateNorm === summaryNorm) return true;
  // Compacted echo: candidate starts with the request text that appears deep
  // in the rendered prompt. Many agents compact system messages and echo back
  // just the core request. Check if the candidate's first 200 chars appear
  // verbatim inside the rendered prompt (case-sensitive, after normalizing).
  if (promptNorm && candidateNorm.length > 50) {
    const firstChunk = candidateNorm.slice(0, 200);
    if (promptNorm.includes(firstChunk)) return true;
    // Also check the reverse: the prompt appears inside the candidate (when
    // the agent echoes the entire prompt with extra commentary appended).
    if (firstChunk.length > 100 && candidateNorm.includes(promptNorm.slice(0, 200))) return true;
  }
  // Check if candidate is mostly just the request portion embedded in the prompt.
  // Extract text between "Request:" and the next section marker in the rendered prompt.
  if (promptNorm.includes('request:')) {
    const reqStart = promptNorm.indexOf('request:');
    const sectionMarkers = ['execution rules:', 'output rules:', 'additional context:'];
    let reqEnd = promptNorm.length;
    for (const marker of sectionMarkers) {
      const idx = promptNorm.indexOf(marker, reqStart + 8);
      if (idx !== -1 && idx < reqEnd) reqEnd = idx;
    }
    const requestText = promptNorm.slice(reqStart, Math.min(reqEnd, reqStart + 500)).trim();
    if (requestText.length > 30 && candidateNorm.startsWith(requestText.slice(0, 100))) return true;
  }
  return false;
}

/**
 * Read the agent's response from the contract file {artifactDir}/response.md.
 * The output-rules block in prompt-renderer instructs the agent to write its
 * final written response there, giving bridge-logger a deterministic source
 * instead of scraping the session transcript. Returns null if the file is
 * missing or empty.
 */
async function readResponseFile(eventId, occurrenceId, maxChars = 8000) {
  try {
    const canonicalDir = getOccurrenceArtifactDir({ eventId, occurrenceId });
    const responsePath = path.join(canonicalDir, 'response.md');
    const stat = await fs.promises.stat(responsePath).catch(() => null);
    if (!stat?.isFile()) return null;
    if (stat.size > 512 * 1024) return null;
    const raw = await fs.promises.readFile(responsePath, 'utf8');
    const text = String(raw || '').trim();
    if (!text) return null;
    return {
      text: text.slice(0, maxChars),
      path: responsePath,
      name: 'response.md',
      size: stat.size,
    };
  } catch (err) {
    console.warn('[bridge-logger] readResponseFile failed (non-fatal):', err?.message);
    return null;
  }
}

async function readBestArtifactText(eventId, occurrenceId, maxChars = 8000) {
  try {
    const canonicalDir = getOccurrenceArtifactDir({ eventId, occurrenceId });
    const files = await scanArtifactDirRecursive(canonicalDir, 3);
    if (!files?.length) return null;
    const ranked = [...files].sort((a, b) => {
      const score = (name) => {
        const lower = String(name || '').toLowerCase();
        if (lower.endsWith('.txt') || lower.endsWith('.md')) return 0;
        if (lower.endsWith('.json')) return 1;
        if (lower.endsWith('.html') || lower.endsWith('.htm')) return 2;
        return 3;
      };
      return score(a.name) - score(b.name);
    });
    for (const file of ranked) {
      try {
        const stat = await fs.promises.stat(file.path);
        if (!stat.isFile()) continue;
        if (stat.size > 512 * 1024) continue;
        const raw = await fs.promises.readFile(file.path, 'utf8');
        const text = String(raw || '').trim();
        if (!text) continue;
        return {
          text: text.slice(0, maxChars),
          path: file.path,
          name: file.name,
          size: stat.size,
        };
      } catch {
        continue;
      }
    }
  } catch (err) {
    console.warn('[bridge-logger] readBestArtifactText failed (non-fatal):', err?.message);
  }
  return null;
}

async function resolveAgendaOutput({ sessionTarget, sessionId, eventId, occurrenceId, renderedPrompt, summaryText, fromLineOffset = null }) {
  const result = {
    output: String(summaryText || ''),
    outputSource: 'cron_summary',
    outputMeta: {
      sessionTarget: sessionTarget || null,
      sessionId: sessionId || null,
      sessionLineOffset: fromLineOffset,
      promptEchoDetected: false,
      sessionOutputUsed: false,
      artifactUsed: false,
      artifactPath: null,
      artifactName: null,
      artifactSize: null,
    },
  };

  // ── Primary capture: the `response.md` contract ────────────────────────────
  // The output-rules block in prompt-renderer instructs the agent to write its
  // final written response to {artifactDir}/response.md. When present, this is
  // the deterministic source and sidesteps session-transcript scraping, prompt
  // echo heuristics, and retry-with-backoff races entirely.
  // Note: `response.md` is flushed synchronously by the agent, so we give it
  // one short grace-period retry in case the cron run finished slightly ahead
  // of the file flush.
  let responseFile = await readResponseFile(eventId, occurrenceId);
  if (!responseFile) {
    await new Promise(r => setTimeout(r, 1500));
    responseFile = await readResponseFile(eventId, occurrenceId);
  }
  if (responseFile && !looksLikePromptEcho(responseFile.text, renderedPrompt, summaryText)) {
    result.output = responseFile.text;
    result.outputSource = 'response_file';
    result.outputMeta.artifactUsed = true;
    result.outputMeta.artifactPath = responseFile.path;
    result.outputMeta.artifactName = responseFile.name;
    result.outputMeta.artifactSize = responseFile.size;
    return result;
  }

  if (sessionTarget === 'main') {
    // Pass fromLineOffset and occurrenceId. The occurrenceId enables marker-based
    // scanning: bridge-logger finds the [AGENDA_MARKER:occurrence_id=...] line in the
    // session to precisely locate where this task was injected, regardless of session
    // growth between scheduling and firing times.
    let sessionOutput = await readLastAssistantFromSession(sessionTarget, sessionId, fromLineOffset, occurrenceId);

    // ── Session error sentinel: empty assistant turn with an errorMessage (e.g. rate-limit) ─
    // Don't retry — the error is definitive. Fail immediately with the real error text.
    if (typeof sessionOutput === 'string' && sessionOutput.startsWith('__SESSION_ERROR__:')) {
      const errMsg = sessionOutput.slice('__SESSION_ERROR__:'.length);
      result.output = null;
      result.outputSource = 'no_output';
      result.outputMeta.sessionError = errMsg;
      return result;
    }

    // ── Fix #1: Retry with backoff for main-session no_output race condition ─
    // The agent writes its response asynchronously to the session file.
    // If bridge-logger scans before the response is flushed, it falsely
    // reports no_output. Retry up to 3 times with 3→5→7 second backoff
    // (max ~15s total delay before declaring failure).
    let retries = 0;
    while (!sessionOutput && retries < 3) {
      retries++;
      const delayMs = [3000, 5000, 7000][retries - 1];
      console.log(`[bridge-logger] resolveAgendaOutput: no output on first scan — retry ${retries}/3 after ${delayMs}ms for occurrence ${occurrenceId}`);
      await new Promise(r => setTimeout(r, delayMs));
      sessionOutput = await readLastAssistantFromSession(sessionTarget, sessionId, fromLineOffset, occurrenceId);
      // Also check for session error sentinel on retries
      if (typeof sessionOutput === 'string' && sessionOutput.startsWith('__SESSION_ERROR__:')) {
        const errMsg = sessionOutput.slice('__SESSION_ERROR__:'.length);
        result.output = null;
        result.outputSource = 'no_output';
        result.outputMeta.sessionError = errMsg;
        return result;
      }
      if (sessionOutput) {
        console.log(`[bridge-logger] resolveAgendaOutput: found output on retry ${retries} for occurrence ${occurrenceId} (${sessionOutput.trim().length} chars)`);
      }
    }

    if (sessionOutput && !looksLikePromptEcho(sessionOutput, renderedPrompt, summaryText)) {
      result.output = sessionOutput;
      result.outputSource = 'main_session_assistant';
      result.outputMeta.sessionOutputUsed = true;
      return result;
    }
    if (sessionOutput) {
      result.outputMeta.promptEchoDetected = true;
    } else if (fromLineOffset == null) {
      // No offset recorded AND no session output found — likely a pre-fix occurrence.
      // Log a warning but still fall back to artifact/summary rather than silently
      // returning the wrong output from an unrelated task.
      console.warn(`[bridge-logger] resolveAgendaOutput: no session output and no fromLineOffset for occurrence ${occurrenceId} — falling back (backward-compat; this may indicate a pre-fix occurrence)`);
    } else {
      // fromLineOffset IS set (post-fix) — the task had proper injection boundaries.
      // readLastAssistantFromSession scanned the bounded range and found nothing,
      // even after retries. This means the task truly produced no output.
      // Do NOT fall back to artifacts or session-global scan — that would contaminate
      // this task's result with output from a completely unrelated earlier task.
      console.warn(`[bridge-logger] resolveAgendaOutput: no session output even after retries (fromLineOffset=${fromLineOffset}) for occurrence ${occurrenceId} — marking no_output (task failed/rate-limited)`);
      const sf = await resolveSessionFile(sessionTarget, sessionId);
      let fileSize = -1;
      try { if (sf) fileSize = fs.statSync(sf).size; } catch {}
      let totalLines = -1;
      try { if (sf) totalLines = fs.readFileSync(sf, 'utf8').split('\n').filter(Boolean).length; } catch {}
      result.output = null;
      result.outputSource = 'no_output';
      result.outputMeta._diagnostics = {
        retryAttempts: retries,
        sessionFileSize: fileSize,
        sessionTotalLines: totalLines,
        scanStartLine: fromLineOffset,
        linesScanned: Math.max(-1, totalLines - fromLineOffset),
      };
      result.outputSource = 'no_output';
      return result;
    }
  }

  if (sessionTarget !== 'main') {
    // ── Fix: For isolated runs, run.summary IS the agent's actual output ─────────
    // (unlike main-session runs where run.summary is the prompt input).
    // Use run.summary directly — it contains the real response text.
    // The prompt-echo check against summaryText is skipped for isolated runs
    // because summaryText == sessionOutput, so comparing them always triggers a
    // false-positive match (identical text flagged as "prompt echo").
    const isolatedOutput = summaryText;
    if (isolatedOutput && isolatedOutput.trim()) {
      result.output = isolatedOutput.trim().slice(0, 8000);
      result.outputSource = 'cron_summary';
    } else {
      // No output at all — mark as no_output so the run is correctly
      // treated as failed (succeeded = false) rather than falsely succeeding.
      result.output = null;
      result.outputSource = 'no_output';
    }
  }

  const artifactText = await readBestArtifactText(eventId, occurrenceId);
  if (artifactText && !looksLikePromptEcho(artifactText.text, renderedPrompt, summaryText)) {
    result.output = artifactText.text;
    result.outputSource = 'artifact_text';
    result.outputMeta.artifactUsed = true;
    result.outputMeta.artifactPath = artifactText.path;
    result.outputMeta.artifactName = artifactText.name;
    result.outputMeta.artifactSize = artifactText.size;
    return result;
  }

  result.outputMeta.promptEchoDetected = looksLikePromptEcho(result.output, renderedPrompt, summaryText);
  if (result.outputMeta.promptEchoDetected && renderedPrompt) {
    result.outputSource = 'prompt_echo_fallback';
  }
  return result;
}

/**
 * Delete Qdrant memory entries that were written by a failed isolated session.
 * Parses the session JSONL for memory_store tool result IDs.
 * We use proper JSON parsing (not regex) to avoid false positives.
 */
async function cleanupFailedCronSessionMemories(sessionId) {
  if (!sessionId) return;
  const sessionFilePath = path.join(OPENCLAW_HOME, "agents", "main", "sessions", `${sessionId}.jsonl`);
  const ids = [];
  try {
    const raw = fs.readFileSync(sessionFilePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      // Look for tool result lines where the tool was memory_store
      const role = parsed?.role ?? parsed?.message?.role ?? "";
      if (role !== "tool") continue;
      const toolName = parsed?.name ?? parsed?.message?.name ?? "";
      if (toolName !== "memory_store") continue;
      // The result content contains the stored memory id
      const content = parsed?.content ?? parsed?.message?.content ?? "";
      const text = typeof content === "string" ? content : JSON.stringify(content);
      const match = text.match(/["']id["']\s*:\s*["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/i);
      if (match?.[1]) ids.push(match[1]);
    }
  } catch {
    // Session file may not exist yet or be unreadable — skip silently
    return;
  }
  if (ids.length === 0) return;
  try {
    const resp = await fetch("http://localhost:6333/collections/memories/points/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [...new Set(ids)] }),
    });
    if (resp.ok) {
      console.log(`[bridge-logger] cron cleanup: deleted ${ids.length} orphaned Qdrant entries from session ${sessionId}`);
    } else {
      console.warn(`[bridge-logger] cron cleanup: Qdrant delete returned ${resp.status} for session ${sessionId}`);
    }
  } catch (err) {
    console.warn(`[bridge-logger] cron cleanup: Qdrant request failed for session ${sessionId}:`, err.message);
  }
}

/**
 * Emit a structured agenda log entry into agent_logs.
 * These are the events visible in the Agenda Logs panel.
 * event_type uses the "agenda.*" namespace so they can be filtered.
 */
async function emitAgendaLog(sql, {
  workspaceId,
  agentDbId,
  agentId,
  occurrenceId,
  sessionKey,
  eventType,   // e.g. "agenda.started" | "agenda.succeeded" | "agenda.failed" | "agenda.fallback"
  level,       // "info" | "warn" | "error"
  message,
  rawPayload = null,
}) {
  const preview = String(message || "").slice(0, 240);
  try {
    // Ensure agent row exists (agent_id is NOT NULL in agent_logs)
    let resolvedAgentDbId = agentDbId;
    if (!resolvedAgentDbId && workspaceId && agentId) {
      resolvedAgentDbId = await ensureAgent(sql, workspaceId, agentId);
    }
    if (!resolvedAgentDbId) {
      console.warn('[bridge-logger] emitAgendaLog: could not resolve agentDbId, skipping log');
      return;
    }
    await sql`
      INSERT INTO agent_logs (
        workspace_id, agent_id, runtime_agent_id, occurred_at, level, type,
        message, event_type, session_key, direction, channel_type,
        message_preview, is_json, contains_pii, agenda_occurrence_id,
        raw_payload
      ) VALUES (
        ${workspaceId}, ${resolvedAgentDbId}, ${agentId}, now(), ${level}, 'agenda',
        ${message}, ${eventType}, ${sessionKey || null}, 'internal', 'internal',
        ${preview}, ${rawPayload != null}, false, ${occurrenceId || null},
        ${rawPayload ? sql.json(rawPayload) : null}
      )
      ON CONFLICT DO NOTHING
    `;
  } catch (err) {
    // Non-fatal — log emission failure must never break the main sync path
    console.warn('[bridge-logger] emitAgendaLog failed:', err?.message);
  }
}


/**
 * Process a single finished cron run line and write results to the DB.
 *
 * Flow (per run):
 *   1. Find occurrence by cron_job_id — status must be queued or running
 *   2. Claim it: queued → running with locked_at = run start time
 *      (enables the stale-running sweep in the scheduler)
 *   3. Write final result via domain transitions (succeeded / needs_retry)
 *   4. Write agenda_run_attempts + agenda_run_steps (cron_job_id column)
 *   5. pg_notify so the UI updates immediately
 */
async function handleCronRunLine(getSql, jobId, line) {
  let run;
  try { run = JSON.parse(line); } catch { return; }

  if (run?.action !== "finished") return;

  const sql = getSql();

  // Find the occurrence that owns this cron job.
  const occurrences = await sql`
    SELECT ao.id as occurrence_id, ao.agenda_event_id, ao.latest_attempt_no,
           ao.rendered_prompt, ao.status, ao.scheduled_for,
           ao.session_line_offset,
           ae.title, ae.default_agent_id, ae.execution_window_minutes, ae.session_target
    FROM agenda_occurrences ao
    JOIN agenda_events ae ON ae.id = ao.agenda_event_id
    WHERE ao.cron_job_id = ${jobId}
    LIMIT 1
  `;

  if (occurrences.length === 0) {
    // No matching occurrence — non-agenda cron job (e.g. memory-audit, healthcheck) or orphaned
    return;
  }

  // If the occurrence is already in a terminal state (succeeded/failed/cancelled),
  // still emit the agenda log but skip DB state transitions (they already happened).
  //
  // EXCEPTION — repair mis-condemned runs: 'needs_retry' is not truly terminal, it
  // is awaiting a retry. If this finished line reports the run actually succeeded
  // (status 'ok'), the scheduler's orphan sweep almost certainly mis-condemned a
  // completed run (the deleteAfterRun race). Fall through to the success path to
  // REPAIR it to 'succeeded' instead of letting a needless, duplicate retry fire.
  const repairFromNeedsRetry = occurrences[0].status === 'needs_retry' && run.status === 'ok';
  const alreadyTerminal = !repairFromNeedsRetry &&
    ['succeeded', 'failed', 'cancelled', 'needs_retry'].includes(occurrences[0].status);
  if (repairFromNeedsRetry) {
    console.warn(`[bridge-logger] cron ${jobId} → occurrence ${occurrences[0].occurrence_id} was needs_retry but run finished ok — repairing to succeeded`);
  }
  if (alreadyTerminal) {
    // Log was missed (e.g. bridge-logger was down) — emit a catch-up log entry only.
    const occ2 = occurrences[0];
    // Even for catch-up isolated runs, send Telegram if we missed the notification.
    if (occ2.session_target === 'isolated' && run.status === 'ok') {
      notifyMainSession('isolated', {
        title: occ2.title, status: 'succeeded',
        summary: run.summary || '[output unavailable]',
        occurrenceId: occ2.occurrence_id, eventId: occ2.agenda_event_id,
        sessionId: null,
      }).catch((err) => console.error(`[bridge-logger] catch-up notifyMainSession failed: ${err?.message || err}`));
    }
    const wid2 = (() => { try { return sql`SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`.then(r => r[0]?.id); } catch { return null; } })();
    void wid2.then(async (w) => {
      if (!w) return;
      await emitAgendaLog(sql, {
        workspaceId: w,
        agentDbId: null,
        agentId: occ2.default_agent_id || 'main',
        occurrenceId: occ2.occurrence_id,
        sessionKey: `agent:main:cron:${jobId}`,
        eventType: run.status === 'ok' ? 'agenda.succeeded' : 'agenda.failed',
        level: run.status === 'ok' ? 'info' : 'error',
        message: `[catch-up] Agenda run ${run.status === 'ok' ? 'succeeded' : 'failed'}: "${occ2.title}" (cron job ${jobId})`,
        rawPayload: { cronJobId: jobId, catchUp: true, durationMs: run.durationMs, model: run.model || null },
      }).catch(() => {});
    }).catch(() => {});
    return;
  }

  const occ = occurrences[0];
  const attemptNo = Number(occ.latest_attempt_no || 0) + 1;
  // succeeded depends on outputResolution which is computed below — placeholder until after resolveAgendaOutput
  const summaryText = String(run.summary || "").slice(0, 8000);
  const startedAt = new Date(run.runAtMs || Date.now());
  const finishedAt = new Date((run.runAtMs || Date.now()) + (run.durationMs || 0));
  const sessionKey = run.sessionKey || `agent:main:cron:${jobId}`;

  // Resolve workspace + agent DB IDs for agenda log emission (best-effort)
  let wid = null;
  let agentDbId = null;
  try {
    const [ws] = await sql`SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1`;
    wid = ws?.id || null;
    if (wid) {
      const [ag] = await sql`SELECT id FROM agents WHERE workspace_id = ${wid} AND openclaw_agent_id = ${occ.default_agent_id || 'main'} LIMIT 1`;
      agentDbId = ag?.id || null;
    }
  } catch { /* non-fatal */ }

  // 4A: Claim the occurrence as running before writing the final result.
  // locked_at is set to the actual run start time so the stale-running sweep
  // has accurate timing data (not just "when bridge-logger processed this").
  // Only claim if still queued — another bridge-logger instance may have won the race.
  if (occ.status === 'queued') {
    const [updated] = await sql`
      UPDATE agenda_occurrences
      SET status = 'running',
          locked_at = ${startedAt}
      WHERE id = ${occ.occurrence_id}
        AND status = 'queued'
      RETURNING id
    `;
    if (!updated) {
      console.log(`[bridge-logger] cron ${jobId} → occurrence ${occ.occurrence_id} already claimed by another process`);
    } else {
      console.log(`[bridge-logger] cron ${jobId} → occurrence ${occ.occurrence_id} claimed as running (was queued)`);
      await emitAgendaLog(sql, {
        workspaceId: wid,
        agentDbId,
        agentId: occ.default_agent_id || 'main',
        occurrenceId: occ.occurrence_id,
        sessionKey,
        eventType: 'agenda.started',
        level: 'info',
        message: `Agenda run started: "${occ.title}" (attempt ${attemptNo}, cron job ${jobId})`,
        rawPayload: { cronJobId: jobId, attemptNo, model: run.model || null, sessionId: run.sessionId || null },
      });
    }
  } else {
    // Not queued — already running (e.g. promotePastDueToRunning claimed it first).
    // Emit started log anyway so agenda logs are complete.
    if (occ.status === 'running') {
      await emitAgendaLog(sql, {
        workspaceId: wid,
        agentDbId,
        agentId: occ.default_agent_id || 'main',
        occurrenceId: occ.occurrence_id,
        sessionKey,
        eventType: 'agenda.started',
        level: 'info',
        message: `Agenda run started: "${occ.title}" (attempt ${attemptNo}, cron job ${jobId})`,
        rawPayload: { cronJobId: jobId, attemptNo, model: run.model || null, sessionId: run.sessionId || null },
      });
    }
  }

  // Always notify SSE of 'running' state — even if already running (promotePastDueToRunning
  // may have claimed it first). This ensures the UI always sees the running state transition.
  await sql`SELECT pg_notify('agenda_change', ${JSON.stringify({ action: 'started', occurrenceId: occ.occurrence_id, eventId: occ.agenda_event_id })})`;
  console.log(`[bridge-logger] cron ${jobId} → SSE notified for running state (occurrence ${occ.occurrence_id})`);

  // For main session runs, read the actual agent output from the session JSONL.
  // run.summary is the rendered prompt (input), not the agent's response.
  // The cron run JSON has no sessionId field, so we resolve the session file via sessions.json.
  // session_line_offset scopes the scan to only lines written during this task, preventing
  // cross-task contamination in the shared agent:main:main session file.
  const outputResolution = await resolveAgendaOutput({
    sessionTarget: occ.session_target,
    sessionId: run.sessionId || null,
    eventId: occ.agenda_event_id,
    occurrenceId: occ.occurrence_id,
    renderedPrompt: occ.rendered_prompt,
    summaryText,
    fromLineOffset: occ.session_line_offset ?? null,
  });
  // A run is succeeded only if: the cron job itself succeeded (status=ok) AND the task
  // produced actual output. If outputSource='no_output', the task ran but produced
  // nothing (e.g. rate-limit / session failure) — treat that as a failure so it can retry.
  const succeeded = run.status === 'ok' && outputResolution.outputSource !== 'no_output';
  const agentOutput = outputResolution.output;
  const outputLen = agentOutput != null ? agentOutput.length : 0;
  console.log(`[bridge-logger] cron ${jobId} → output source=${outputResolution.outputSource} (${outputLen} chars)`);
  await emitAgendaLog(sql, {
    workspaceId: wid,
    agentDbId,
    agentId: occ.default_agent_id || 'main',
    occurrenceId: occ.occurrence_id,
    sessionKey,
    eventType: 'agenda.output_captured',
    level: outputResolution.outputSource === 'prompt_echo_fallback' ? 'warn' : 'info',
    message: `Output captured from ${outputResolution.outputSource.replaceAll('_', ' ')} for "${occ.title}"`,
    rawPayload: {
      cronJobId: jobId,
      outputSource: outputResolution.outputSource,
      sessionTarget: occ.session_target || null,
      promptEchoDetected: outputResolution.outputMeta.promptEchoDetected,
      artifactPath: outputResolution.outputMeta.artifactPath,
      artifactName: outputResolution.outputMeta.artifactName || null,
      artifactSize: outputResolution.outputMeta.artifactSize || null,
      outputPreview: String(agentOutput || '').slice(0, 300),
    },
  });

  const runDelayMs = startedAt.getTime() - new Date(occ.scheduled_for || startedAt).getTime();

  if (succeeded) {
    // ── Success path ──────────────────────────────────────────────────────────
    // CRITICAL: update status BEFORE SSE so calendar always reloads with correct status.
    // transitionOccurrenceToSucceeded requires status='running' — if promotePastDueToRunning
    // won the race 5s earlier, this would return null and leave the DB with stale status='running',
    // causing the SSE-reload to show 'running' (blue) instead of 'succeeded' (green).
    // Solution: unconditional UPDATE to 'succeeded', then SSE, then write attempt.
    const [updated] = await sql`
      UPDATE agenda_occurrences
      SET status = 'succeeded',
          latest_attempt_no = ${attemptNo},
          cron_job_id = NULL,
          queued_at = NULL,
          locked_at = NULL,
          cron_synced_at = now()
      WHERE id = ${occ.occurrence_id}
        AND status IN ('running', 'queued', 'scheduled', 'needs_retry')
      RETURNING id
    `;
    // Always notify SSE of final status — calendar reloads and finds status='succeeded'.
    await sql`SELECT pg_notify('agenda_change', ${JSON.stringify({ action: 'succeeded', occurrenceId: occ.occurrence_id, eventId: occ.agenda_event_id })})`;
    console.log(`[bridge-logger] cron ${jobId} → SSE notified for succeeded state (occurrence ${occ.occurrence_id}, updated=${!!updated})`);
    if (!updated) {
      // Occurrence already succeeded by another process — log but continue (attempt may differ)
      console.log(`[bridge-logger] cron ${jobId} → occurrence ${occ.occurrence_id} already succeeded (race guard)`);
    }

    const [attempt] = await sql`
      INSERT INTO agenda_run_attempts
        (occurrence_id, attempt_no, cron_job_id, status, started_at, finished_at, summary)
      VALUES
        (${occ.occurrence_id}, ${attemptNo}, ${jobId}, 'succeeded',
         ${startedAt}, ${finishedAt}, ${agentOutput})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;

    if (attempt?.id) {
      const artifactPayload = await scanRunArtifacts(occ.occurrence_id, occ.agenda_event_id);
      await sql`
        INSERT INTO agenda_run_steps
          (run_attempt_id, step_order, agent_id, input_payload, output_payload, artifact_payload, status, started_at, finished_at)
        VALUES
          (${attempt.id}, 0, ${occ.default_agent_id || 'main'},
           ${sql.json({ cronJobId: jobId, prompt: String(occ.rendered_prompt || '') })},
           ${sql.json({ output: agentOutput, outputSource: outputResolution.outputSource, outputMeta: outputResolution.outputMeta })},
           ${artifactPayload ? sql.json(artifactPayload) : null},
           'succeeded', ${startedAt}, ${finishedAt})
        ON CONFLICT DO NOTHING
      `;
      if (artifactPayload?.files?.length) {
        console.log(`[bridge-logger] cron ${jobId} → ${artifactPayload.files.length} artifact(s): ${artifactPayload.files.map(f=>f.name).join(', ')}`);
      }
    }

    // Notify main session (isolated runs: system event in main session; main runs: Telegram)
    // Fire-and-forget but log failures so we can debug missing notifications.
    notifyMainSession(occ.session_target || 'isolated', {
      title: occ.title, status: 'succeeded', summary: agentOutput,
      occurrenceId: occ.occurrence_id, eventId: occ.agenda_event_id,
    }).catch((err) => {
      console.error(`[bridge-logger] notifyMainSession failed for occurrence ${occ.occurrence_id}: ${err?.message || err}`);
    });
    await emitAgendaLog(sql, {
      workspaceId: wid, agentDbId,
      agentId: occ.default_agent_id || 'main',
      occurrenceId: occ.occurrence_id, sessionKey,
      eventType: 'agenda.succeeded', level: 'info',
      message: `Agenda run succeeded: "${occ.title}" (attempt ${attemptNo}, ${run.durationMs ? Math.round(run.durationMs/1000)+'s' : 'unknown duration'})`,
      rawPayload: {
        cronJobId: jobId,
        attemptNo,
        durationMs: run.durationMs,
        summary: agentOutput,
        model: run.model || null,
        scheduledFor: occ.scheduled_for || null,
        startedAt,
        finishedAt,
        runDelayMs,
        runDelaySeconds: Math.round(runDelayMs / 1000),
        outputSource: outputResolution.outputSource,
      },
    });
    console.log(`[bridge-logger] cron ${jobId} → occurrence ${occ.occurrence_id} succeeded (attempt ${attemptNo})`);
    // Clean up the cron job from the gateway — output is in DB, no longer needed.
    deleteCronJobSilently(jobId).catch(() => {});

  } else {
    // ── Failure path ──────────────────────────────────────────────────────────
    const isNoOutput = outputResolution.outputSource === 'no_output';
    const sessionErrorMsg = outputResolution.outputMeta?.sessionError ?? null;
    const failureReason = isNoOutput
      ? sessionErrorMsg
        ? `session_error: ${sessionErrorMsg}`
        : `no_output: task produced no output (possible rate-limit / session failure, model=${run.model || 'unknown'})`
      : String(run.error || '').slice(0, 2000);
    const targetStatus = 'needs_retry';

    // CRITICAL: always update status before SSE — same race-guard fix as success path.
    // transitionOccurrenceToNeedsRetry/Failed require status='running'; if promotePastDueToRunning
    // won the race, those functions would return null and the DB would keep status='running',
    // causing the SSE-reload to never show 'needs_retry'/'failed' in the calendar.
    const [statusUpdated] = await sql`
      UPDATE agenda_occurrences
      SET status = ${targetStatus},
          latest_attempt_no = ${attemptNo},
          cron_job_id = NULL,
          queued_at = NULL,
          locked_at = NULL,
          cron_synced_at = now()
      WHERE id = ${occ.occurrence_id}
        AND status IN ('running', 'queued', 'scheduled')
      RETURNING id
    `;
    await sql`SELECT pg_notify('agenda_change', ${JSON.stringify({ action: targetStatus, occurrenceId: occ.occurrence_id, eventId: occ.agenda_event_id })})`;
    console.log(`[bridge-logger] cron ${jobId} → SSE notified for ${targetStatus} (occurrence ${occ.occurrence_id}, dbUpdated=${!!statusUpdated})`);

    const [attempt] = await sql`
      INSERT INTO agenda_run_attempts
        (occurrence_id, attempt_no, cron_job_id, status, started_at, finished_at, summary, error_message)
      VALUES
        (${occ.occurrence_id}, ${attemptNo}, ${jobId}, 'failed',
         ${startedAt}, ${finishedAt}, ${agentOutput}, ${failureReason})
      ON CONFLICT DO NOTHING
      RETURNING id
    `;

    if (attempt?.id) {
      const artifactPayloadFail = await scanRunArtifacts(occ.occurrence_id, occ.agenda_event_id);
      await sql`
        INSERT INTO agenda_run_steps
          (run_attempt_id, step_order, agent_id, input_payload, output_payload, artifact_payload, status,
           started_at, finished_at, error_message)
        VALUES
          (${attempt.id}, 0, ${occ.default_agent_id || 'main'},
           ${sql.json({ cronJobId: jobId, prompt: String(occ.rendered_prompt || '') })},
           ${sql.json({ output: agentOutput, outputSource: outputResolution.outputSource, outputMeta: outputResolution.outputMeta })},
           ${artifactPayloadFail ? sql.json(artifactPayloadFail) : null},
           'failed', ${startedAt}, ${finishedAt}, ${failureReason})
        ON CONFLICT DO NOTHING
      `;
    }

    // Qdrant cleanup for failed isolated sessions
    if (run.sessionId) {
      cleanupFailedCronSessionMemories(run.sessionId).catch((e) =>
        console.warn(`[bridge-logger] cron cleanup error for session ${run.sessionId}:`, e.message)
      );
    }

    {
      // Manual retry path — notify user that attention is needed.
      await emitAgendaLog(sql, {
        workspaceId: wid, agentDbId,
        agentId: occ.default_agent_id || 'main',
        occurrenceId: occ.occurrence_id, sessionKey,
        eventType: 'agenda.needs_retry', level: 'warn',
        message: `Agenda run needs manual retry: "${occ.title}" (attempt ${attemptNo}) — ${failureReason.slice(0, 300)}`,
        rawPayload: {
          cronJobId: jobId,
          attemptNo,
          error: failureReason.slice(0, 1000),
          durationMs: run.durationMs,
          requiresManualRetry: true,
          scheduledFor: occ.scheduled_for || null,
          startedAt,
          finishedAt,
          runDelayMs,
          runDelaySeconds: Math.round(runDelayMs / 1000),
          outputSource: outputResolution.outputSource,
        },
      });
      console.warn(`[bridge-logger] cron ${jobId} → occurrence ${occ.occurrence_id} NEEDS RETRY: ${failureReason.slice(0, 120)}`);
      notifyMainSession(occ.session_target || 'isolated', {
        title: occ.title, status: 'needs_retry', summary: failureReason.slice(0, 400),
        occurrenceId: occ.occurrence_id, eventId: occ.agenda_event_id,
      }).catch(() => {});
      deleteCronJobSilently(jobId).catch(() => {});
    }
  }
}
/**
 * Delete a completed cron job from the gateway — silently, best-effort.
 * Called after every run (success or failure) is synced to DB so the gateway
 * stays clean. If --delete-after-run was already set this is a no-op (job gone).
 */
async function deleteCronJobSilently(jobId) {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("openclaw", ["cron", "rm", jobId], { timeout: 10000 });
    console.log(`[bridge-logger] cron ${jobId} deleted after run sync`);
  } catch {
    // Already deleted (--delete-after-run), or gateway unavailable — both fine.
  }
}

/**
 * Scan for files created by an agenda run and return { files } payload for artifact_payload.
 * Scans the canonical occurrence artifact dir recursively.
 * Returns null if no files found.
 */
async function scanRunArtifacts(occurrenceId, eventId) {
  try {
    const canonicalDir = getOccurrenceArtifactDir({ eventId, occurrenceId });
    const files = await scanArtifactDirRecursive(canonicalDir, 3);
    const seen = new Set();
    const unique = files.filter(f => {
      if (seen.has(f.name)) return false;
      seen.add(f.name);
      return true;
    });
    return unique.length > 0 ? { files: unique } : null;
  } catch (err) {
    console.warn('[bridge-logger] scanRunArtifacts error (non-fatal):', err?.message);
    return null;
  }
}

/**
 * Send a Telegram notification for an agenda task result.
 * Works for both main-session and isolated sessions.
 * Non-fatal.
 */
async function sendTelegramNotification(title, status, summary, occurrenceId, eventId) {
  try {
    const sessionsPath = path.join(OPENCLAW_HOME, 'agents', 'main', 'sessions', 'sessions.json');
    let chatId;
    try {
      const data = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      for (const val of Object.values(data)) {
        if (val?.deliveryContext?.channel === 'telegram' && val?.deliveryContext?.to) {
          chatId = String(val.deliveryContext.to).replace(/^telegram:/, '');
          break;
        }
      }
    } catch { return; }
    if (!chatId) {
      console.warn('[bridge-logger] Telegram notification skipped — no telegram chatId found in sessions.json');
      return;
    }

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const statusEmoji = status === 'succeeded' ? '✅' : status === 'needs_retry' ? '⚠️' : '❌';
    const statusLabel = status === 'succeeded' ? 'completed' : status === 'needs_retry' ? 'needs retry' : 'failed';
    const snippet = summary && summary.length > 0
      ? `\n\n${String(summary).slice(0, 400)}${summary.length > 400 ? '\u2026' : ''}`
      : '';

    let artifactSection = '';
    if (status === 'succeeded' && occurrenceId && eventId) {
      try {
        const artifactPayload = await scanRunArtifacts(occurrenceId, eventId);
        const files = artifactPayload?.files ?? [];
        if (files.length > 0) {
          const listed = files.slice(0, 5).map((f) => `• ${f.name}\n  ${f.path}`).join('\n');
          const more = files.length > 5 ? `\n• ...and ${files.length - 5} more` : '';
          artifactSection = `\n\n💾 Saved files\n${listed}${more}`;
        }
      } catch { /* best effort */ }
    }

    const header = `${statusEmoji} Agenda task "${title}" ${statusLabel}`;
    const text = `${header}${snippet}${artifactSection}`;
    await execFileAsync('openclaw', [
      'message', 'send',
      '--channel', 'telegram',
      '--target', chatId,
      '--message', text,
    ], { timeout: 15000 });
    console.log(`[bridge-logger] Telegram notification for "${title}" (${status})`);
  } catch (err) {
    console.warn('[bridge-logger] Telegram notification failed:', err?.message);
  }
}

/**
 * Inject a short system event into the main OpenClaw session to notify
 * the main agent that an agenda task finished.
 * For isolated sessions: also sends a Telegram notification so the user
 * knows the task completed without having to check Mission Control.
 * For main session runs: only sends Telegram (output already in chat).
 * Non-fatal.
 */
async function notifyMainSession(sessionTarget, { title, status, summary, occurrenceId, eventId }) {
  const isIsolated = sessionTarget !== 'main';

  if (isIsolated) {
    // Isolated session: inject system event AND send Telegram notification
    try {
      const statusEmoji = status === 'succeeded' ? '✅' : status === 'needs_retry' ? '⚠️' : '❌';
      const statusLabel = status === 'succeeded' ? 'completed' : status === 'needs_retry' ? 'needs retry' : 'failed';
      const snippet = summary ? ` — ${String(summary).slice(0, 120)}${summary.length > 120 ? '…' : ''}` : '';
      const systemEvent = `${statusEmoji} Agenda task "${title}" ${statusLabel}${snippet}. (Mission Control)`;
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("openclaw", [
        "cron", "add",
        "--name", `MC-notify: ${title}`,
        "--at", "5s",
        "--session", "main",
        "--system-event", systemEvent,
        "--delete-after-run",
        "--json",
      ], { timeout: 15000 });
    } catch (err) {
      console.warn("[bridge-logger] notifyMainSession system event failed (non-fatal):", err?.message);
    }
    // Also send a Telegram notification for isolated sessions
    await sendTelegramNotification(title, status, summary, occurrenceId, eventId);
    return;
  }

  // Main session run — send summary directly to Telegram (output already lands in chat)
  await sendTelegramNotification(title, status, summary, occurrenceId, eventId);
}

/**
 * Promote occurrences that are queued/scheduled but whose scheduled_for is
 * already in the past to 'running'. OpenClaw fires the cron job at the
 * scheduled time but bridge-logger only sees the result after it finishes.
 * This gives the UI a real-time 'running' state instead of staying 'queued'
 * for the full execution duration.
 */
async function promotePastDueToRunning(getSql) {
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT ao.id as occurrence_id, ao.agenda_event_id, ao.cron_job_id
      FROM agenda_occurrences ao
      WHERE ao.status IN ('queued', 'scheduled')
        AND ao.scheduled_for <= now() - interval '5 seconds'
        AND ao.cron_job_id IS NOT NULL
    `;
    for (const row of rows) {
      const [updated] = await sql`
        UPDATE agenda_occurrences
        SET status = 'running', locked_at = now()
        WHERE id = ${row.occurrence_id}
          AND status IN ('queued', 'scheduled')
        RETURNING id
      `;
      if (updated) {
        await sql`SELECT pg_notify('agenda_change', ${JSON.stringify({ action: 'started', occurrenceId: row.occurrence_id, eventId: row.agenda_event_id })})`;
        console.log(`[bridge-logger] promote: occurrence ${row.occurrence_id} → running (past due, cron job ${row.cron_job_id})`);
      }
    }
  } catch (err) {
    // Non-fatal — next cycle will retry
    console.warn('[bridge-logger] promotePastDueToRunning failed:', err?.message);
  }
}

async function main() {
  ensureStateDir();
  acquireLockOrExit();
  loadOffsets();

  const databaseUrl = process.env.DATABASE_URL || process.env.OPENCLAW_DATABASE_URL || "postgresql://openclaw:openclaw@localhost:5432/mission_control";
  let sql = postgres(databaseUrl, { max: 2, prepare: false });

  const getSql = () => sql;

  const resetSql = () => {
    try {
      void sql.end({ timeout: 1 });
    } catch {
      // ignore
    }
    sql = postgres(databaseUrl, { max: 2, prepare: false });
  };

  const guarded = async (fn) => {
    try {
      await fn();
    } catch (error) {
      if (isConnectionEndedError(error)) {
        console.warn("[bridge-logger] DB connection ended; reconnecting...");
        resetSql();
        return;
      }
      throw error;
    }
  };

  const scan = () => {
    const sessionFiles = listSessionFiles();
    for (const filePath of sessionFiles) tailFile(getSql, resetSql, filePath, handleSessionLine);

    const gatewayFiles = listGatewayFiles();
    for (const filePath of gatewayFiles) tailFile(getSql, resetSql, filePath, handleGatewayLine);

    // Watch cron run result files — each file is one job, each line is one completed run.
    // This is the source of truth for agenda occurrence result sync (replaces scheduler polling).
    const cronRunFiles = listCronRunFiles();
    for (const filePath of cronRunFiles) {
      const jobId = cronJobIdFromPath(filePath);
      tailFile(
        getSql,
        resetSql,
        filePath,
        (sql, fp, line) => handleCronRunLine(getSql, jobId, line).catch((err) =>
          console.error(`[bridge-logger] cron run handler error for job ${jobId}:`, err.message)
        ),
        true, // startFromBeginning — cron run result is already written when we first see the file
      );
    }

    flushOffsets();
  };

  // Service health heartbeat
  async function blWriteHeartbeat(status = "running", lastError = null) {
    try {
      await getSql()`
        INSERT INTO service_health (name, status, pid, last_heartbeat_at, last_error, started_at, updated_at)
        VALUES (${BL_SERVICE_NAME}, ${status}, ${process.pid}, now(), ${lastError}, now(), now())
        ON CONFLICT (name) DO UPDATE SET
          status = ${status},
          pid = ${process.pid},
          last_heartbeat_at = now(),
          last_error = COALESCE(${lastError}, service_health.last_error),
          updated_at = now()
      `;
    } catch (err) {
      console.warn("[bridge-logger] Service heartbeat write failed:", err.message);
    }
  }

  scan();
  const scanTimer = setInterval(scan, SCAN_INTERVAL_MS);
  // Promote past-due queued occurrences to 'running' every 5s so UI shows live state
  void guarded(() => promotePastDueToRunning(getSql));
  const promoteTimer = setInterval(() => void guarded(() => promotePastDueToRunning(getSql)), 5000);
  const deadLetterTimer = setInterval(() => {
    void guarded(() => replayDeadLetters(getSql()));
  }, DEAD_LETTER_REPLAY_MS);
  const heartbeatTimer = setInterval(() => {
    void guarded(() => heartbeat(getSql()));
  }, HEARTBEAT_INTERVAL_MS);

  // Service health heartbeat on startup + every 30s
  void guarded(() => blWriteHeartbeat("running"));
  const serviceHeartbeatTimer = setInterval(() => {
    void guarded(() => blWriteHeartbeat("running"));
  }, 30_000);

  const shutdown = async () => {
    clearInterval(scanTimer);
    clearInterval(promoteTimer);
    clearInterval(deadLetterTimer);
    clearInterval(heartbeatTimer);
    clearInterval(serviceHeartbeatTimer);
    await blWriteHeartbeat("stopped").catch(() => {});
    flushOffsets();
    await sql.end({ timeout: 3 });
    releaseLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[bridge-logger] started");
}

main().catch((error) => {
  console.error("[bridge-logger] fatal:", error?.stack || error?.message || error);
  releaseLock();
  process.exit(1);
});
