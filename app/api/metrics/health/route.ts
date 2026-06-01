import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { pingMysql } from "@/lib/metrics/mysql";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session?.email) {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  if (!(await isModuleEnabled("metrics"))) {
    return NextResponse.json(
      { ok: false, error: "Metrics module is disabled. Enable it in Settings." },
      { status: 503 },
    );
  }
  const result = await pingMysql();
  return NextResponse.json({ ok: result.ok, ...result });
}
