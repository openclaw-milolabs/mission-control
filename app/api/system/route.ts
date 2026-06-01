import { NextResponse } from "next/server";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(process.cwd());

type Json = Record<string, unknown>;
const ok = (data: Json = {}) => NextResponse.json({ ok: true, ...data });
const fail = (msg: string, status = 400) => NextResponse.json({ ok: false, error: msg }, { status });

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Json;
    const action = String(body.action || "");

    if (action === "checkUpdates") {
      try {
        await execFileAsync("git", ["fetch", "--quiet"], { cwd: PROJECT_ROOT, timeout: 15000 });
        const { stdout } = await execFileAsync("git", ["rev-list", "HEAD..origin/main", "--count"], { cwd: PROJECT_ROOT, timeout: 5000 });
        const behind = parseInt(stdout.trim(), 10) || 0;
        let latestCommit = "";
        if (behind > 0) {
          const { stdout: logOut } = await execFileAsync("git", ["log", "origin/main", "-1", "--format=%s"], { cwd: PROJECT_ROOT, timeout: 5000 });
          latestCommit = logOut.trim();
        }
        return ok({ behind, latestCommit });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "Failed to check updates");
      }
    }

    if (action === "updateSystem" || action === "update") {
      try {
        const sql = (await import("@/lib/local-db")).getSql();
        const running = await sql`
          select count(*)::int as count
          from agenda_occurrences
          where status = 'running'
        `;
        const runningCount = Number(running[0]?.count ?? 0);
        if (runningCount > 0) {
          return fail(`Cannot update while ${runningCount} agenda event${runningCount === 1 ? " is" : "s are"} still running. Wait until execution finishes, then update again.`, 409);
        }

        const { stdout: pullOut } = await execFileAsync("git", ["pull", "--ff-only"], { cwd: PROJECT_ROOT, timeout: 30000 });
        await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], { cwd: PROJECT_ROOT, timeout: 120000 });
        try {
          // The `db` container has no /workspace mount (only db-init does).
          // Pipe schema.sql through stdin instead of asking the container to read a file path.
          const schemaPath = resolve(PROJECT_ROOT, "db/schema.sql");
          if (!existsSync(schemaPath)) {
            throw new Error(`schema not found at ${schemaPath}`);
          }
          await new Promise<void>((resolveP, rejectP) => {
            const proc = spawn(
              "docker",
              ["compose", "exec", "-T", "db", "psql", "-U", "openclaw", "-d", "mission_control", "-v", "ON_ERROR_STOP=1"],
              { cwd: PROJECT_ROOT },
            );
            let stderr = "";
            proc.stderr.on("data", (d) => { stderr += d.toString(); });
            proc.on("error", rejectP);
            proc.on("close", (code) => {
              if (code === 0) resolveP();
              else rejectP(new Error(`psql exited ${code}: ${stderr.trim()}`));
            });
            const sql = readFileSync(schemaPath, "utf8");
            proc.stdin.write(sql);
            proc.stdin.end();
          });
        } catch (dbErr) {
          console.warn("[system] DB migration warning (non-fatal):", dbErr instanceof Error ? dbErr.message : dbErr);
        }
        await execFileAsync("bash", ["-lc", "env -u NODE_ENV NODE_ENV=production npm run build"], {
          cwd: PROJECT_ROOT,
          timeout: 180000,
        });

        const mcServices = resolve(PROJECT_ROOT, "scripts/mc-services.sh");
        if (existsSync(mcServices)) {
          const child = spawn("bash", ["-lc", `sleep 1; bash '${mcServices}' restart`], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: "ignore",
          });
          child.unref();
        }

        return ok({
          message: "Update complete. Migrations applied. Services are restarting in the background.",
          pullOutput: pullOut.trim(),
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "Update failed");
      }
    }

    if (action === "cleanReset") {
      try {
        const mcServices = resolve(PROJECT_ROOT, "scripts/mc-services.sh");

        // Ensure DB container is running before trying to exec
        await execFileAsync("docker", ["compose", "up", "-d", "db"], { cwd: PROJECT_ROOT, timeout: 30000 });

        await execFileAsync(
          "docker",
          ["compose", "exec", "-T", "db", "psql", "-U", "openclaw", "-d", "mission_control", "-c", "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"],
          { cwd: PROJECT_ROOT, timeout: 30000 },
        );
        await execFileAsync("docker", ["compose", "run", "--rm", "db-init"], {
          cwd: PROJECT_ROOT,
          timeout: 120000,
        });

        const artifactsRoot = resolve(PROJECT_ROOT, "runtime-artifacts");
        await rm(artifactsRoot, { recursive: true, force: true });
        await mkdir(artifactsRoot, { recursive: true });

        if (existsSync(mcServices)) {
          for (const svc of ["bridge-logger", "agenda-scheduler"]) {
            await execFileAsync("bash", [mcServices, "restart", svc], { cwd: PROJECT_ROOT, timeout: 30000 }).catch(() => {});
          }
        }

        return ok({ message: "Clean reset complete. Database and runtime artifacts wiped; worker services restarted." });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "Clean reset failed");
      }
    }

    if (action === "uninstall") {
      try {
        const mcServices = resolve(PROJECT_ROOT, "scripts/mc-services.sh");
        if (existsSync(mcServices)) {
          await execFileAsync("bash", [mcServices, "stop"], { cwd: PROJECT_ROOT, timeout: 15000 }).catch(() => {});
        }
        await execFileAsync("docker", ["compose", "down", "--volumes", "--remove-orphans"], { cwd: PROJECT_ROOT, timeout: 30000 }).catch(() => {});
        for (const cmd of ["mc-install", "mc-clean", "mc-update", "mc-uninstall", "mc-services", "mc-dev"]) {
          await execFileAsync("rm", ["-f", `/usr/local/bin/${cmd}`]).catch(() => {});
        }
        return ok({ message: "Mission Control uninstalled. Services stopped, volumes removed. You can safely delete this directory." });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "Uninstall failed");
      }
    }

    return fail(`Unknown action: ${action}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "System operation failed", 500);
  }
}
