import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Json = Record<string, unknown>;

const ok = (data: Json = {}): NextResponse => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400): NextResponse =>
  NextResponse.json({ ok: false, error: message }, { status });

const PROJECT_ROOT = resolve(process.cwd());
const MC_SERVICES_SCRIPT = resolve(PROJECT_ROOT, "scripts/mc-services.sh");
const LOG_DIR = resolve(PROJECT_ROOT, ".runtime/logs");
const PID_DIR = resolve(PROJECT_ROOT, ".runtime/pids");

function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(service: string): Promise<number | null> {
  try {
    const content = await readFile(resolve(PID_DIR, `${service}.pid`), "utf8");
    const pid = parseInt(content.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const sql = getSql();
    // v2: agenda-worker removed — execution now via openclaw cron
    const ALL_SERVICES = ["gateway-sync", "bridge-logger", "agenda-scheduler", "nextjs"];

    // Get service_health rows
    const rows = await sql`SELECT * FROM service_health ORDER BY name ASC`;
    const healthMap = new Map(rows.map((r: Record<string, unknown>) => [r.name, r]));

    // Build service list — always show all known services, even if not in health table yet
    const services = [];
    for (const name of ALL_SERVICES) {
      const pid = await readPidFile(name);
      const pidAlive = pid ? pidRunning(pid) : false;
      const row = healthMap.get(name);

      if (row) {
        services.push({
          name,
          status: pidAlive ? "running" : (row.status === "running" ? "stopped" : row.status),
          pid: pid ?? row.pid,
          pidAlive,
          lastHeartbeatAt: row.last_heartbeat_at,
          lastError: row.last_error,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
        });
      } else {
        // No health row yet — derive status from PID file
        services.push({
          name,
          status: pidAlive ? "running" : "stopped",
          pid: pid ?? null,
          pidAlive,
          lastHeartbeatAt: null,
          lastError: null,
          startedAt: null,
          updatedAt: null,
        });
      }
    }

    return ok({ services });
  } catch {
    return fail("Failed to fetch services", 500);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { guardAdmin } = await import("@/lib/auth/roles");
    const guard = await guardAdmin();
    if ("error" in guard) return guard.error;
    const body = (await request.json()) as Json;
    const action = String(body.action || "");
    const service = String(body.service || "");

    if (!service) return fail("Service name is required");

    const validServices = ["gateway-sync", "bridge-logger", "agenda-scheduler", "nextjs"];
    if (!validServices.includes(service)) return fail(`Invalid service: ${service}`);

    if (action === "logs") {
      const lines = Math.min(Number(body.lines) || 100, 500);
      const logFile = resolve(LOG_DIR, `${service}.log`);

      try {
        const content = await readFile(logFile, "utf8");
        const allLines = content.split("\n");
        const lastLines = allLines.slice(-lines).join("\n");
        return ok({ logs: lastLines, service, lines: Math.min(lines, allLines.length) });
      } catch {
        return ok({ logs: "(no log file found)", service, lines: 0 });
      }
    }

    if (["start", "stop", "restart"].includes(action)) {
      try {
        const { stdout, stderr } = await execFileAsync("bash", [MC_SERVICES_SCRIPT, action, service], {
          timeout: 30000,
          env: process.env,
          cwd: PROJECT_ROOT,
        });
        return ok({ output: (stdout + stderr).trim(), service, action });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail(`Service ${action} failed: ${msg.slice(0, 200)}`, 500);
      }
    }

    return fail(`Unknown action: ${action}`);
  } catch {
    return fail("Service operation failed", 500);
  }
}
