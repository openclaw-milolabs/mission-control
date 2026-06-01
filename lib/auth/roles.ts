import { NextResponse } from "next/server";
import { getSql } from "@/lib/local-db";
import { getSession, type SessionUser } from "@/lib/auth/session";

/**
 * Roles + allowlist.
 *
 * Auth (proxy.ts + /api/auth/session) verifies the user is a real Azure AD
 * identity in our tenant. That alone is not enough — anyone in the tenant
 * (every employee) would have full access. This module narrows access to a
 * named allowlist in the `allowed_users` table.
 *
 * Bootstrap rule: when the table has zero rows the next successful sign-in
 * auto-creates an 'admin' row for that user. After that, only listed users
 * may sign in.
 */

export type Role = "admin" | "member";

export type AllowedUser = {
  email: string;
  role: Role;
  display_name: string | null;
  created_at: string;
  created_by_email: string | null;
  last_signed_in_at: string | null;
};

let _schemaEnsured = false;

/** Idempotent. Runs once per process. */
export async function ensureRolesSchema(sql: ReturnType<typeof getSql>): Promise<void> {
  if (_schemaEnsured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS allowed_users (
      email text PRIMARY KEY,
      role text NOT NULL DEFAULT 'member',
      display_name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by_email text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_signed_in_at timestamptz
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS allowed_users_role_idx ON allowed_users(role)`;
  _schemaEnsured = true;
}

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Check whether the given email is allowed to sign in. If the allowlist is
 * empty, bootstrap-create this user as 'admin'. Returns the role on success
 * or null on rejection.
 */
export async function checkAndBootstrapAllowedUser(
  user: SessionUser,
): Promise<{ ok: true; role: Role; bootstrapped: boolean } | { ok: false; reason: string }> {
  if (!user.email) return { ok: false, reason: "ID token missing email claim." };
  const sql = getSql();
  await ensureRolesSchema(sql);
  const email = normEmail(user.email);

  const existing = await sql`select role from allowed_users where email = ${email} limit 1` as Array<{ role: string }>;
  if (existing[0]) {
    await sql`update allowed_users set last_signed_in_at = now(), display_name = coalesce(${user.name || null}, display_name) where email = ${email}`;
    return { ok: true, role: (existing[0].role as Role) || "member", bootstrapped: false };
  }

  // Bootstrap: if the table is empty this becomes the first admin.
  const countRow = await sql`select count(*)::int as n from allowed_users` as Array<{ n: number }>;
  const total = Number(countRow[0]?.n ?? 0);
  if (total === 0) {
    await sql`
      insert into allowed_users (email, role, display_name, created_by_email, last_signed_in_at)
      values (${email}, 'admin', ${user.name || null}, ${email}, now())
      on conflict (email) do nothing
    `;
    return { ok: true, role: "admin", bootstrapped: true };
  }

  // Allowlist has rows but this email isn't in it — reject.
  return {
    ok: false,
    reason: "This account is not allowed to sign in to Mission Control. Ask an admin to add your email to the allowlist.",
  };
}

/** Look up a session user's role without mutating last_signed_in_at. */
export async function getSessionRole(user: SessionUser): Promise<Role | null> {
  if (!user.email) return null;
  const sql = getSql();
  await ensureRolesSchema(sql);
  const rows = await sql`select role from allowed_users where email = ${normEmail(user.email)} limit 1` as Array<{ role: string }>;
  if (!rows[0]) return null;
  return (rows[0].role as Role) || "member";
}

/** Convenience: throwable Error type so route handlers can wrap into a 403. */
export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Server route guard. Returns the session+role, or a NextResponse that the
 * route can return directly (e.g. `if ('error' in guard) return guard.error`).
 */
export async function guardAdmin(): Promise<
  | { session: SessionUser; role: "admin" }
  | { error: NextResponse }
> {
  const session = await getSession();
  if (!session?.email) {
    return { error: NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 }) };
  }
  const role = await getSessionRole(session);
  if (role !== "admin") {
    return {
      error: NextResponse.json(
        { ok: false, error: "Admin role required. Ask an admin to grant you access." },
        { status: 403 },
      ),
    };
  }
  return { session, role: "admin" };
}

export async function guardAuthed(): Promise<
  | { session: SessionUser; role: Role }
  | { error: NextResponse }
> {
  const session = await getSession();
  if (!session?.email) {
    return { error: NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401 }) };
  }
  const role = await getSessionRole(session);
  if (!role) {
    return {
      error: NextResponse.json(
        { ok: false, error: "This account is not allowed. Ask an admin to add your email." },
        { status: 403 },
      ),
    };
  }
  return { session, role };
}

/** List all allowed users. Admin-only callers expected. */
export async function listAllowedUsers(): Promise<AllowedUser[]> {
  const sql = getSql();
  await ensureRolesSchema(sql);
  return (await sql`
    select email, role, display_name, created_at, created_by_email, last_signed_in_at
    from allowed_users
    order by role asc, email asc
  `) as AllowedUser[];
}

export async function addAllowedUser(email: string, role: Role, addedByEmail: string, displayName?: string | null): Promise<void> {
  const sql = getSql();
  await ensureRolesSchema(sql);
  await sql`
    insert into allowed_users (email, role, display_name, created_by_email)
    values (${normEmail(email)}, ${role}, ${displayName || null}, ${normEmail(addedByEmail)})
    on conflict (email) do update set role = excluded.role, display_name = coalesce(excluded.display_name, allowed_users.display_name), updated_at = now()
  `;
}

export async function updateAllowedUserRole(email: string, role: Role): Promise<void> {
  const sql = getSql();
  await ensureRolesSchema(sql);
  await sql`update allowed_users set role = ${role}, updated_at = now() where email = ${normEmail(email)}`;
}

export async function removeAllowedUser(email: string): Promise<void> {
  const sql = getSql();
  await ensureRolesSchema(sql);
  await sql`delete from allowed_users where email = ${normEmail(email)}`;
}
