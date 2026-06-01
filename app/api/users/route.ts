import { NextResponse } from "next/server";
import {
  addAllowedUser,
  guardAdmin,
  listAllowedUsers,
  removeAllowedUser,
  updateAllowedUserRole,
  type Role,
} from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

type Json = Record<string, unknown>;
const ok = (data: Json = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export async function GET() {
  const guard = await guardAdmin();
  if ("error" in guard) return guard.error;
  const users = await listAllowedUsers();
  return ok({ users });
}

export async function POST(request: Request) {
  const guard = await guardAdmin();
  if ("error" in guard) return guard.error;
  const body = (await request.json().catch(() => ({}))) as Json;
  const action = String(body.action || "");

  if (action === "add") {
    const email = String(body.email || "").trim();
    const role = String(body.role || "member") as Role;
    const displayName = body.displayName ? String(body.displayName).trim() : null;
    if (!email || !email.includes("@")) return fail("Valid email is required.");
    if (role !== "admin" && role !== "member") return fail("Role must be admin or member.");
    await addAllowedUser(email, role, guard.session.email, displayName);
    return ok();
  }

  if (action === "updateRole") {
    const email = String(body.email || "").trim();
    const role = String(body.role || "") as Role;
    if (!email) return fail("Email is required.");
    if (role !== "admin" && role !== "member") return fail("Role must be admin or member.");
    // Prevent demoting yourself out of admin (would lock you out of this UI).
    if (email.toLowerCase() === guard.session.email.toLowerCase() && role !== "admin") {
      return fail("You can't demote yourself. Ask another admin to do it.");
    }
    await updateAllowedUserRole(email, role);
    return ok();
  }

  if (action === "remove") {
    const email = String(body.email || "").trim();
    if (!email) return fail("Email is required.");
    if (email.toLowerCase() === guard.session.email.toLowerCase()) {
      return fail("You can't remove your own access. Ask another admin to do it.");
    }
    await removeAllowedUser(email);
    return ok();
  }

  return fail(`Unsupported action: ${action}`);
}
