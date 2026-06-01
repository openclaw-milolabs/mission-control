import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Parses the shared openclaw secrets file at ~/.config/openclaw/secrets.env.
 * Same convention used by the catalog clickup skill and the mission-control
 * catalog skill — one file holds credentials for every integration.
 *
 * Format: KEY=VALUE per line, `#` comments allowed, optional matching surrounding
 * quotes are stripped.
 */

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";
const SECRETS_PATH = join(HOME_DIR, ".config", "openclaw", "secrets.env");

let _cache: Record<string, string> | null = null;
let _cacheMtimeMs = 0;

export type MysqlCredentials = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | null;
  // True if every required key was found.
  ok: boolean;
  // When ok=false, surface why so the UI can tell the operator.
  reason: string | null;
  // Path we looked at — useful for the "configure MySQL" empty state.
  secretsPath: string;
};

function parse(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadSecrets(): Record<string, string> {
  if (!existsSync(SECRETS_PATH)) {
    _cache = {};
    _cacheMtimeMs = 0;
    return _cache;
  }
  try {
    const { statSync } = require("node:fs") as typeof import("node:fs");
    const mtime = statSync(SECRETS_PATH).mtimeMs;
    if (_cache && mtime === _cacheMtimeMs) return _cache;
    _cache = parse(SECRETS_PATH);
    _cacheMtimeMs = mtime;
    return _cache;
  } catch {
    return _cache || {};
  }
}

export function getMysqlCredentials(): MysqlCredentials {
  const sec = loadSecrets();
  // Process env overrides — useful for dev / tests where we don't want to edit
  // the shared file.
  const host = (process.env.MYSQL_HOST || sec.MYSQL_HOST || "").trim();
  const user = (process.env.MYSQL_USERNAME || sec.MYSQL_USERNAME || "").trim();
  const password = (process.env.MYSQL_PASS || sec.MYSQL_PASS || "").trim();
  const database = (process.env.MYSQL_DATABASE || sec.MYSQL_DATABASE || "").trim() || null;
  const portRaw = (process.env.MYSQL_PORT || sec.MYSQL_PORT || "3306").trim();
  const port = Number.parseInt(portRaw, 10) || 3306;

  const missing: string[] = [];
  if (!host) missing.push("MYSQL_HOST");
  if (!user) missing.push("MYSQL_USERNAME");
  if (!password) missing.push("MYSQL_PASS");

  if (missing.length > 0) {
    return {
      host, port, user, password, database,
      ok: false,
      reason: `Missing in ~/.config/openclaw/secrets.env: ${missing.join(", ")}`,
      secretsPath: SECRETS_PATH,
    };
  }
  return { host, port, user, password, database, ok: true, reason: null, secretsPath: SECRETS_PATH };
}
