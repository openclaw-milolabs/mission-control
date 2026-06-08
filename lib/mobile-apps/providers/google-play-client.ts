import { readFileSync } from "node:fs";
import { google } from "googleapis";
import type { androidpublisher_v3 } from "googleapis";
import type { GoogleConfig } from "@/lib/mobile-apps/config";

/** The single OAuth scope the Android Publisher reviews API requires. */
export const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

/**
 * Load the service-account credentials. Prefers the file path; the BASE64
 * variable is an opt-in fallback for runtimes that cannot read external files.
 * The decoded JSON is never logged.
 */
function loadServiceAccount(cfg: GoogleConfig): Record<string, unknown> {
  try {
    if (cfg.serviceAccountJsonPath) {
      return JSON.parse(readFileSync(cfg.serviceAccountJsonPath, "utf8")) as Record<string, unknown>;
    }
    if (cfg.serviceAccountJsonBase64) {
      const json = Buffer.from(cfg.serviceAccountJsonBase64, "base64").toString("utf8");
      return JSON.parse(json) as Record<string, unknown>;
    }
  } catch (err) {
    const why = err instanceof SyntaxError ? "is not valid JSON" : "could not be read";
    throw new Error(`Google Play service account ${why}. Check GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH.`);
  }
  throw new Error(
    "Google Play service account is not configured. Set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH in secrets.env.",
  );
}

/**
 * Build an authenticated Android Publisher v3 client using the configured
 * service account. Server-side only — never import this into a client component.
 */
export function createAndroidPublisherClient(cfg: GoogleConfig): androidpublisher_v3.Androidpublisher {
  const credentials = loadServiceAccount(cfg);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [ANDROID_PUBLISHER_SCOPE] });
  return google.androidpublisher({ version: "v3", auth });
}
