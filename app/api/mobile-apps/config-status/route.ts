import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { loadMobileReviewsConfig, publicConfigStatus } from "@/lib/mobile-apps/config";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

/**
 * Reports whether each store is enabled + configured so the UI can show a
 * "credentials missing / store disabled" warning. Returns ONLY booleans and a
 * reason string — never a key id, issuer id, path, package name, or key material.
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const cfg = loadMobileReviewsConfig();
    return ok({ stores: publicConfigStatus(cfg), negativeThreshold: cfg.sync.negativeThreshold });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load config status", 500);
  }
}
