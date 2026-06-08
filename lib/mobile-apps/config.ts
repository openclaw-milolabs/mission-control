import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Expand a leading `~` to the user's home dir. `~` is a shell convention, not a
 * filesystem one — Node's fs functions treat it literally — so operators who put
 * `~/...` in secrets.env would otherwise hit "file could not be read".
 */
export function expandHomePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Configuration for the official Google Play + App Store Connect review
 * integration. Credentials are loaded from the shared OpenClaw secrets file
 * (~/.config/openclaw/secrets.env) — the same convention used by the metrics
 * MySQL integration — with an optional repo-root `secrets.env` for local dev,
 * and process.env taking highest precedence.
 *
 * SECURITY: nothing in here is ever returned to the browser. The route layer
 * must send only `publicConfigStatus(...)`, which contains booleans + a reason
 * string and never a key id, issuer id, path, or key material.
 */

const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";
const OPENCLAW_SECRETS_PATH = join(HOME_DIR, ".config", "openclaw", "secrets.env");
const REPO_SECRETS_PATH = join(process.cwd(), "secrets.env");

/** Placeholder tokens that count as "not set" so the example file never reads as configured. */
const PLACEHOLDERS = new Set(["", "replace_me", "changeme", "change-me", "your-value"]);

function clean(v: string | undefined | null): string {
  const s = (v ?? "").trim();
  return PLACEHOLDERS.has(s.toLowerCase()) ? "" : s;
}

function isTrue(v: string | undefined): boolean {
  return clean(v).toLowerCase() === "true";
}

// ── Secrets file parsing (KEY=VALUE, # comments, optional quotes) ────────────

function parseEnvFile(filePath: string): Record<string, string> {
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const _cache: { path: string; mtime: number; data: Record<string, string> }[] = [];

function readFileCached(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    const mtime = statSync(filePath).mtimeMs;
    const hit = _cache.find((c) => c.path === filePath);
    if (hit && hit.mtime === mtime) return hit.data;
    const data = parseEnvFile(filePath);
    if (hit) {
      hit.mtime = mtime;
      hit.data = data;
    } else {
      _cache.push({ path: filePath, mtime, data });
    }
    return data;
  } catch {
    return {};
  }
}

/** Merge the OpenClaw secrets file, an optional repo secrets.env, and process.env. */
export function loadSecretsEnv(): Record<string, string> {
  return {
    ...readFileCached(OPENCLAW_SECRETS_PATH),
    ...readFileCached(REPO_SECRETS_PATH),
    ...(process.env as Record<string, string>),
  };
}

// ── Public, secret-free types ───────────────────────────────────────────────

export type StoreConfigStatus = {
  enabled: boolean;
  configured: boolean;
  error: string | null;
};

export type GoogleConfig = StoreConfigStatus & {
  packageName: string | null;
  serviceAccountJsonPath: string | null;
  serviceAccountJsonBase64: string | null;
};

export type AppleConfig = StoreConfigStatus & {
  appId: string | null;
  issuerId: string | null;
  keyId: string | null;
  privateKeyPath: string | null;
  privateKeyBase64: string | null;
};

export type SyncConfig = {
  maxPages: number;
  concurrency: number;
  negativeThreshold: number;
};

export type MobileReviewsConfig = {
  google: GoogleConfig;
  apple: AppleConfig;
  sync: SyncConfig;
};

const syncSchema = z.object({
  maxPages: z.coerce.number().int().min(1).max(100).default(10),
  concurrency: z.coerce.number().int().min(1).max(10).default(2),
  negativeThreshold: z.coerce.number().int().min(1).max(5).default(3),
});

/**
 * Pure: turn a flat env record into a validated config. No filesystem access,
 * so it is fully unit-testable.
 */
export function parseMobileReviewsConfig(env: Record<string, string>): MobileReviewsConfig {
  // Google
  const gEnabled = isTrue(env.GOOGLE_PLAY_ENABLED);
  const packageName = clean(env.GOOGLE_PLAY_PACKAGE_NAME) || null;
  const saPath = clean(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH) || null;
  const saB64 = clean(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64) || null;
  let gError: string | null = null;
  if (gEnabled) {
    const missing: string[] = [];
    if (!packageName) missing.push("GOOGLE_PLAY_PACKAGE_NAME");
    if (!saPath && !saB64)
      missing.push("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH (or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64)");
    if (missing.length) gError = `Missing required Google Play config: ${missing.join(", ")}`;
  }
  const google: GoogleConfig = {
    enabled: gEnabled,
    configured: gEnabled && gError === null,
    error: gError,
    packageName,
    serviceAccountJsonPath: saPath,
    serviceAccountJsonBase64: saB64,
  };

  // Apple
  const aEnabled = isTrue(env.APPSTORE_CONNECT_ENABLED);
  const issuerId = clean(env.APPSTORE_CONNECT_ISSUER_ID) || null;
  const keyId = clean(env.APPSTORE_CONNECT_KEY_ID) || null;
  const appId = clean(env.APPSTORE_CONNECT_APP_ID) || null;
  const pkPath = clean(env.APPSTORE_CONNECT_PRIVATE_KEY_PATH) || null;
  const pkB64 = clean(env.APPSTORE_CONNECT_PRIVATE_KEY_BASE64) || null;
  let aError: string | null = null;
  if (aEnabled) {
    const missing: string[] = [];
    if (!issuerId) missing.push("APPSTORE_CONNECT_ISSUER_ID");
    if (!keyId) missing.push("APPSTORE_CONNECT_KEY_ID");
    if (!appId) missing.push("APPSTORE_CONNECT_APP_ID");
    if (!pkPath && !pkB64)
      missing.push("APPSTORE_CONNECT_PRIVATE_KEY_PATH (or APPSTORE_CONNECT_PRIVATE_KEY_BASE64)");
    if (missing.length) aError = `Missing required App Store Connect config: ${missing.join(", ")}`;
  }
  const apple: AppleConfig = {
    enabled: aEnabled,
    configured: aEnabled && aError === null,
    error: aError,
    appId,
    issuerId,
    keyId,
    privateKeyPath: pkPath,
    privateKeyBase64: pkB64,
  };

  const sync = syncSchema.parse({
    maxPages: env.MOBILE_REVIEWS_SYNC_MAX_PAGES,
    concurrency: env.MOBILE_REVIEWS_SYNC_CONCURRENCY,
    negativeThreshold: env.MOBILE_REVIEWS_NEGATIVE_THRESHOLD,
  });

  return { google, apple, sync };
}

/** Load + parse config from the real secrets file(s) and process.env. */
export function loadMobileReviewsConfig(): MobileReviewsConfig {
  return parseMobileReviewsConfig(loadSecretsEnv());
}

/**
 * The ONLY config shape allowed to leave the server. Booleans + a reason string;
 * never a path, key id, issuer id, package name, or any key material.
 */
export function publicConfigStatus(config: MobileReviewsConfig): {
  google: StoreConfigStatus;
  apple: StoreConfigStatus;
} {
  return {
    google: { enabled: config.google.enabled, configured: config.google.configured, error: config.google.error },
    apple: { enabled: config.apple.enabled, configured: config.apple.configured, error: config.apple.error },
  };
}
