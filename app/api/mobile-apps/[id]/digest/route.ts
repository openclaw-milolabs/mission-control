import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { generateDigest } from "@/lib/mobile-apps/digest";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled.", 503);
    const { id } = await params;
    const sql = getSql();
    const digests = await sql`
      select id::text, period_start, period_end, summary_md, sentiment_score, top_themes, generated_by_agent_id, created_at
      from app_review_digests
      where mobile_app_id = ${id}
      order by created_at desc
      limit 20
    `;
    return ok({ digests });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load digests", 500);
  }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled.", 503);
    const { id } = await params;
    const digestId = await generateDigest(id);
    return ok({ id: digestId });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to generate digest", 500);
  }
}
