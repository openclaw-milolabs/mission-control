import { NextRequest, NextResponse } from "next/server";
import {
  verifySession,
  createSession,
  sessionCookieAttrs,
  SESSION_DURATION_SECONDS,
  SESSION_REFRESH_THRESHOLD,
} from "@/lib/auth/session";

const PUBLIC_API_PREFIX = "/api/auth";
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF defense in depth: for state-changing requests, require Origin (or fall
 * back to Referer) to be present and match the request's own host. The session
 * cookie is sameSite=lax so most CSRF attempts are blocked at the browser; this
 * blocks the rest.
 */
function isSameOrigin(req: NextRequest): boolean {
  const method = req.method.toUpperCase();
  if (!STATE_CHANGING_METHODS.has(method)) return true;
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const host = req.headers.get("host") || req.nextUrl.host;
  if (!host) return false;
  const expectedHosts = [host];
  // Honour the same X-Forwarded-Host the rest of Next.js does, if a reverse
  // proxy is in front.
  const fwd = req.headers.get("x-forwarded-host");
  if (fwd) expectedHosts.push(fwd);
  const check = (raw: string | null): boolean => {
    if (!raw) return false;
    try {
      const u = new URL(raw);
      return expectedHosts.includes(u.host);
    } catch { return false; }
  };
  if (origin) return check(origin);
  // Fall back to Referer for clients that strip Origin (older browsers, some
  // server-side rendering paths).
  if (referer) return check(referer);
  // Neither header — be strict: refuse.
  return false;
}

export default async function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  if (pathname.startsWith(PUBLIC_API_PREFIX)) return NextResponse.next();
  if (pathname === "/health") return NextResponse.next();

  // CSRF gate for state-changing requests on /api/* surfaces.
  if (pathname.startsWith("/api/") && !isSameOrigin(req)) {
    return NextResponse.json(
      { ok: false, error: "Origin check failed (CSRF protection)." },
      { status: 403 },
    );
  }

  const session = await verifySession(req);

  if (pathname === "/login") {
    // Already authenticated — redirect away to avoid confusion
    if (session) return NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin));
    // Not authenticated — let them through to the login page
    return NextResponse.next();
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const res = NextResponse.next();

  // Sliding window: if the session has less than SESSION_REFRESH_THRESHOLD seconds
  // left, silently re-issue a fresh 24h cookie so active users are never logged out.
  const nowSec = Math.floor(Date.now() / 1000);
  if (session.exp !== undefined && session.exp - nowSec < SESSION_REFRESH_THRESHOLD) {
    const { exp: _exp, ...userFields } = session;
    const refreshed = await createSession(userFields);
    res.cookies.set({ ...sessionCookieAttrs(SESSION_DURATION_SECONDS), value: refreshed });
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
