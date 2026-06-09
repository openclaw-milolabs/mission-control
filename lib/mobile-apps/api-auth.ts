import { getSession } from "@/lib/auth/session";

export type MobileAppsApiAuth = { type: "session"; email: string } | { type: "token"; email: null };

/**
 * Auth for the mobile-apps report APIs that future OpenClaw skills/scripts call.
 * Accepts either an existing logged-in browser session or a bearer token equal to
 * MOBILE_APPS_API_TOKEN. Returns null when neither is present (caller → 401).
 *
 * A blank/unset MOBILE_APPS_API_TOKEN disables token auth entirely, so an empty
 * "Authorization: Bearer " can never authenticate.
 */
export async function requireMobileAppsApiAuth(request: Request): Promise<MobileAppsApiAuth | null> {
  const session = await getSession();
  if (session?.email) return { type: "session", email: session.email };

  const expected = process.env.MOBILE_APPS_API_TOKEN?.trim();
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (expected && token && token === expected) return { type: "token", email: null };
  return null;
}
