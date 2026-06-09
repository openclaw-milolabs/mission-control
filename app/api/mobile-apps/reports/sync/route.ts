import { NextResponse } from "next/server";
import { z } from "zod";
import { getSql } from "@/lib/local-db";
import { isModuleEnabled } from "@/lib/modules/state";
import { ensureMobileAppsSchema } from "@/lib/mobile-apps/ensure-schema";
import { requireMobileAppsApiAuth } from "@/lib/mobile-apps/api-auth";
import { enqueueReportSyncJob } from "@/lib/mobile-apps/report-jobs";

export const dynamic = "force-dynamic";

const fail = (message: string, status = 400, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error: message, ...extra }, { status });

const bodySchema = z.object({
  appId: z.string().uuid().optional(),
  listingId: z.string().uuid().optional(),
  store: z.enum(["google", "apple"]).optional(),
  mode: z.enum(["incremental", "backfill"]).optional(),
  reason: z.string().max(64).optional(),
});

/**
 * API-safe way to request a heavy Google Play report refresh. This endpoint does
 * NOT download or parse any CSV: it only enqueues a job that the detached
 * cron-drained worker picks up, then returns 202 + jobId immediately. No detached
 * process is spawned from Next.js.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireMobileAppsApiAuth(request);
    if (!auth) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return fail("Invalid report sync request.", 422);

    const sql = getSql();
    await ensureMobileAppsSchema(sql);

    const { job, reused } = await enqueueReportSyncJob(sql, {
      appId: parsed.data.appId ?? null,
      listingId: parsed.data.listingId ?? null,
      store: parsed.data.store ?? null,
      mode: parsed.data.mode ?? "incremental",
      reason: parsed.data.reason ?? "api",
      requestedBy: auth.email,
    });

    const running = job.status === "running";
    return NextResponse.json(
      {
        ok: true,
        status: job.status,
        jobId: job.id,
        reused,
        message: running
          ? "A report sync is already running."
          : reused
            ? "A report sync is already queued."
            : "Report sync queued.",
        poll: `/api/mobile-apps/reports/status?jobId=${job.id}`,
      },
      { status: 202 },
    );
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to queue report sync", 500);
  }
}
