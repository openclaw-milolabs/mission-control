import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

export const SESSION_COOKIE = "mc-session";
export const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const SESSION_REFRESH_THRESHOLD = 3 * 24 * 60 * 60; // sliding: refresh if <3 days left

export type SessionUser = {
  sub: string;
  name: string;
  email: string;
  /** JWT expiry as Unix timestamp (seconds). Present when returned by verifySession. */
  exp?: number;
};

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET env var is not set");
  return new TextEncoder().encode(secret);
}

/** Create a signed session JWT for the given user. */
export async function createSession(user: SessionUser): Promise<string> {
  return new SignJWT({ sub: user.sub, name: user.name, email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(getSecret());
}

/**
 * Verify the session cookie from an incoming NextRequest.
 * Edge-runtime safe — uses req.cookies only, no next/headers.
 */
export async function verifySession(req: NextRequest): Promise<SessionUser | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return {
      sub: payload.sub as string,
      name: payload.name as string,
      email: payload.email as string,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/**
 * Read the session from the Next.js cookie store (server components / API routes).
 */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return {
      sub: payload.sub as string,
      name: payload.name as string,
      email: payload.email as string,
    };
  } catch {
    return null;
  }
}

export function sessionCookieAttrs(maxAge: number) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}
