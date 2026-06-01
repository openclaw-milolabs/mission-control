import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";

export const dynamic = "force-dynamic";

export async function GET() {
  const sql = getSql();
  await sql`create table if not exists app_settings (id integer primary key default 1, gateway_token text not null default '', bridge_email text not null default '', setup_completed boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), constraint app_settings_single_row check (id = 1))`;

  const rows = await sql`select setup_completed, bridge_email from app_settings where id = 1 limit 1`;
  const row = rows[0] ?? { setup_completed: true, bridge_email: "" };

  return NextResponse.json({
    setupCompleted: Boolean(row.setup_completed ?? true),
    settings: { bridgeEmail: String(row.bridge_email || "") },
  });
}

export async function POST(request: Request) {
  const sql = getSql();

  // Setup is a one-shot bootstrap flow. Once `setup_completed = true` is
  // recorded, refuse further POSTs except from an admin — otherwise any
  // signed-in user can flip the flag back to false and lock everyone into
  // the wizard, or rewrite the bridge_email.
  await sql`create table if not exists app_settings (id integer primary key default 1, gateway_token text not null default '', bridge_email text not null default '', setup_completed boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), constraint app_settings_single_row check (id = 1))`;
  const existing = await sql`select setup_completed from app_settings where id = 1 limit 1`;
  const alreadyCompleted = Boolean(existing[0]?.setup_completed ?? true);
  if (alreadyCompleted) {
    const { guardAdmin } = await import("@/lib/auth/roles");
    const guard = await guardAdmin();
    if ("error" in guard) return guard.error;
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const bridgeEmail = String(body.bridgeEmail || "").trim();
  const setupCompleted = body.setupCompleted === false ? false : true;

  await sql`
    insert into app_settings (id, bridge_email, setup_completed)
    values (1, ${bridgeEmail}, ${setupCompleted})
    on conflict (id) do update
      set bridge_email = excluded.bridge_email,
          setup_completed = excluded.setup_completed,
          updated_at = now()
  `;

  const saved = await sql`select setup_completed, bridge_email from app_settings where id = 1 limit 1`;
  return NextResponse.json({ ok: true, saved: saved[0] ?? null });
}
