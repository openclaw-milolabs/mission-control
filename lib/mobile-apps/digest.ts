import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getSql } from "@/lib/local-db";

const execFileAsync = promisify(execFile);

type ReviewForPrompt = {
  store: string;
  rating: number | null;
  title: string | null;
  body: string | null;
  submitted_at: string | null;
};

// NOTE: review title/body are interpolated into the agent prompt. For v1 these are
// our own apps' public store reviews, dispatched to a LOCAL agent that only writes
// Markdown — accepted risk. Re-evaluate if user-submitted app sources are ever added.
/** Pure: compose the digest prompt from recent reviews. Exported for testing. */
export function buildDigestPrompt(appName: string, reviews: ReviewForPrompt[]): string {
  const lines = reviews
    .slice(0, 100)
    .map((r) => `- [${r.store}] ${r.rating ?? "?"}★ ${r.title ? r.title + ": " : ""}${(r.body || "").replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return [
    `You are analyzing recent app store reviews for "${appName}".`,
    `Write a concise sentiment digest in Markdown with these sections:`,
    `## Overall sentiment (one line + an approximate score from -1.0 to 1.0)`,
    `## Top complaints (bulleted, most frequent first)`,
    `## Top praise (bulleted)`,
    `## Notable themes (comma-separated tags)`,
    ``,
    `Base it ONLY on these reviews. Do not invent issues not present.`,
    ``,
    `Reviews:`,
    lines || "(no recent reviews)",
  ].join("\n");
}

/** Run an agent turn locally and return its text output. */
async function dispatchAgent(agentId: string, message: string, timeoutMs = 120_000): Promise<string> {
  const cleanEnv = { ...process.env };
  delete cleanEnv.OPENCLAW_GATEWAY_URL;
  delete cleanEnv.OPENCLAW_GATEWAY_TOKEN;
  const { stdout, stderr } = await execFileAsync(
    "openclaw",
    ["agent", "--agent", agentId, "--message", message, "--json", "--local"],
    { timeout: timeoutMs, env: cleanEnv, maxBuffer: 50 * 1024 * 1024 },
  );
  const raw = (stdout || "").trim() ? stdout : stderr || "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`openclaw returned non-JSON output (first 200 chars): ${raw.slice(0, 200)}`);
  }
  const result = parsed as { result?: { payloads?: Array<{ text?: string }> }; payloads?: Array<{ text?: string }> };
  const payloads = result?.result?.payloads ?? result?.payloads ?? [];
  return (
    payloads.map((p: { text?: string }) => p.text ?? "").join("\n").trim() || JSON.stringify(parsed)
  );
}

/** Generate + persist a digest for an app. Returns the new digest row id. */
export async function generateDigest(appId: string, agentId = "main"): Promise<string> {
  const sql = getSql();
  const appRows = (await sql`select name from mobile_apps where id = ${appId} limit 1`) as unknown as Array<{ name: string }>;
  if (!appRows[0]) throw new Error("App not found");

  const reviews = (await sql`
    select l.store, r.rating, r.title, r.body, r.submitted_at
    from app_reviews r
    join mobile_app_listings l on l.id = r.listing_id
    where l.mobile_app_id = ${appId}
    order by r.submitted_at desc nulls last
    limit 100
  `) as unknown as ReviewForPrompt[];

  if (reviews.length === 0) throw new Error("No reviews available to digest yet.");

  const prompt = buildDigestPrompt(appRows[0].name, reviews);
  const summaryMd = await dispatchAgent(agentId, prompt);

  const periodEnd = reviews[0]?.submitted_at ?? null;
  const periodStart = reviews[reviews.length - 1]?.submitted_at ?? null;

  const ins = (await sql`
    insert into app_review_digests (mobile_app_id, period_start, period_end, summary_md, generated_by_agent_id)
    values (${appId}, ${periodStart}, ${periodEnd}, ${summaryMd}, ${agentId})
    returning id::text
  `) as unknown as Array<{ id: string }>;
  return ins[0].id;
}
