import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";
import { expandHomePath, type AppleConfig } from "@/lib/mobile-apps/config";

export const APPSTORE_CONNECT_AUDIENCE = "appstoreconnect-v1";
export const APPSTORE_CONNECT_BASE_URL = "https://api.appstoreconnect.apple.com";
/** Apple rejects tokens older than 20 min; keep ours comfortably short. */
const TOKEN_TTL_SECONDS = 10 * 60;

/**
 * Load the .p8 private key. Prefers the file path; the BASE64 variable is an
 * opt-in fallback. The key material is never logged.
 */
function loadPrivateKeyPem(cfg: AppleConfig): string {
  try {
    if (cfg.privateKeyPath) return readFileSync(expandHomePath(cfg.privateKeyPath), "utf8");
    if (cfg.privateKeyBase64) return Buffer.from(cfg.privateKeyBase64, "base64").toString("utf8");
  } catch {
    throw new Error("App Store Connect private key could not be read. Check APPSTORE_CONNECT_PRIVATE_KEY_PATH.");
  }
  throw new Error(
    "App Store Connect private key is not configured. Set APPSTORE_CONNECT_PRIVATE_KEY_PATH in secrets.env.",
  );
}

/**
 * Pure-ish: create a short-lived ES256 JWT for the App Store Connect API.
 * Header carries `kid`; payload carries `iss`, `aud`, `iat`, `exp`.
 */
export async function createAppStoreConnectJwt(opts: {
  issuerId: string;
  keyId: string;
  privateKeyPem: string;
}): Promise<string> {
  const key = await importPKCS8(opts.privateKeyPem, "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: opts.keyId, typ: "JWT" })
    .setIssuer(opts.issuerId)
    .setAudience(APPSTORE_CONNECT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .sign(key);
}

/** Build a bearer token from configured Apple credentials. */
export async function createAppStoreConnectToken(cfg: AppleConfig): Promise<string> {
  if (!cfg.issuerId || !cfg.keyId) {
    throw new Error("App Store Connect issuer id / key id are not configured.");
  }
  return createAppStoreConnectJwt({
    issuerId: cfg.issuerId,
    keyId: cfg.keyId,
    privateKeyPem: loadPrivateKeyPem(cfg),
  });
}
