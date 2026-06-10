/**
 * Strict UUID check for route params/bodies, so user-supplied ids never reach a
 * `::uuid` SQL cast malformed — that cast throws, which surfaces as an HTTP 500
 * instead of the correct 400/404.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
