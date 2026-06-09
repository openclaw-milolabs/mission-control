import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getOpenClawHome } from "@/scripts/openclaw-config.mjs";

type Json = Record<string, unknown>;
const ok = (data: Json = {}) => NextResponse.json({ ok: true, ...data });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export type TelegramChat = {
  /** Bare Telegram chat id (no "telegram:" prefix). */
  id: string;
  /** Friendly label for the picker. */
  label: string;
  /** Telegram private chats have positive ids; groups/supergroups are negative. */
  type: "private" | "group";
  /** True for the chat used as the "private" default (the owner's DM). */
  isDefault: boolean;
};

/**
 * Pull the first available friendly name from a deliveryContext, if OpenClaw
 * happens to record one. Falls back to null — most contexts only carry channel + to.
 */
function readContextName(ctx: Record<string, unknown>): string | null {
  for (const key of ["chatTitle", "title", "chatName", "name", "displayName"]) {
    const v = ctx[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Enumerate the distinct Telegram chats OpenClaw knows about by scanning the
 * main agent's sessions.json delivery contexts. Used to populate the agenda
 * event "report to" picker. Read-only; never mutates OpenClaw state.
 */
export async function GET() {
  try {
    const sessionsPath = resolve(getOpenClawHome(), "agents", "main", "sessions", "sessions.json");
    let raw: string;
    try {
      raw = readFileSync(sessionsPath, "utf8");
    } catch {
      // No sessions file yet — return an empty list; the UI falls back to "Private (default)".
      return ok({ chats: [] as TelegramChat[] });
    }

    let data: Record<string, { deliveryContext?: Record<string, unknown> }> = {};
    try {
      data = JSON.parse(raw);
    } catch {
      return ok({ chats: [] as TelegramChat[] });
    }

    // id → { name, type } deduped across all sessions.
    const found = new Map<string, { name: string | null; type: "private" | "group" }>();
    for (const val of Object.values(data)) {
      const ctx = val?.deliveryContext;
      if (!ctx || ctx.channel !== "telegram" || !ctx.to) continue;
      const id = String(ctx.to).replace(/^telegram:/, "").trim();
      if (!id) continue;
      const type: "private" | "group" = id.startsWith("-") ? "group" : "private";
      const name = readContextName(ctx);
      const existing = found.get(id);
      // Keep the first non-null name we see for a given id.
      found.set(id, { name: existing?.name ?? name, type });
    }

    // The default "private" target is the first positive (private) chat id.
    let defaultId: string | null = null;
    for (const [id, meta] of found) {
      if (meta.type === "private") { defaultId = id; break; }
    }

    const chats: TelegramChat[] = Array.from(found.entries()).map(([id, meta]) => ({
      id,
      label: meta.name ?? (meta.type === "private" ? `Private chat (${id})` : `Group chat (${id})`),
      type: meta.type,
      isDefault: id === defaultId,
    }));

    // Private chats first, then groups, each stable by id.
    chats.sort((a, b) => {
      if (a.type !== b.type) return a.type === "private" ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

    return ok({ chats, defaultChatId: defaultId });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to load chats", 500);
  }
}
