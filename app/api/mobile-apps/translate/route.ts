import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { loadMobileReviewsConfig } from "@/lib/mobile-apps/config";

export const dynamic = "force-dynamic";

const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

const TARGET = "nl";
const MYMEMORY = "https://api.mymemory.translated.net/get";
const CHUNK = 480; // MyMemory caps each q at ~500 chars on the free tier.

const bodySchema = z.object({
  text: z.string().trim().min(1).max(5000),
  source: z.string().trim().toLowerCase().max(10).optional(),
});

/** Split on whitespace so no chunk exceeds the free-tier length cap. */
function chunkText(text: string): string[] {
  if (text.length <= CHUNK) return [text];
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  let cur = "";
  for (let w of words) {
    // A single token longer than the cap (URL, no-space script, emoji run) would
    // otherwise become an oversized chunk the API rejects — hard-split it.
    while (w.length > CHUNK) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      chunks.push(w.slice(0, CHUNK));
      w = w.slice(CHUNK);
    }
    if ((cur + w).length > CHUNK && cur) {
      chunks.push(cur);
      cur = "";
    }
    cur += w;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

/**
 * Translate review text to Dutch via MyMemory's free, key-less public API.
 * Server-side only. No credentials involved.
 */
export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);
    if (!(await isModuleEnabled("mobile-apps")))
      return fail("Mobile Applications module is disabled. Enable it in Settings.", 503);

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return fail("Invalid translation request.", 422);

    const source = (parsed.data.source && parsed.data.source !== TARGET ? parsed.data.source : "en") || "en";
    if (parsed.data.source === TARGET) return ok({ text: parsed.data.text, source: TARGET });

    const email = loadMobileReviewsConfig().translate.email;
    const parts: string[] = [];
    for (const chunk of chunkText(parsed.data.text)) {
      const url = new URL(MYMEMORY);
      url.searchParams.set("q", chunk);
      url.searchParams.set("langpair", `${source}|${TARGET}`);
      if (email) url.searchParams.set("de", email);
      const res = await fetch(url, { headers: { "User-Agent": "MissionControl/1.0" } });
      if (res.status === 429) return fail("Translation rate limit reached, try again shortly.", 429);
      if (!res.ok) return fail("Translation service is unavailable right now.", 502);
      const json = (await res.json()) as { responseData?: { translatedText?: string }; responseStatus?: number };
      const t = json?.responseData?.translatedText;
      if (!t) return fail("Could not translate this review.", 502);
      parts.push(t);
    }
    return ok({ text: parts.join(""), source });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Translation failed", 500);
  }
}
