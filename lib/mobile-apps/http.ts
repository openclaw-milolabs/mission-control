/**
 * fetch() with a hard timeout and limited retry on 429 / 5xx (honoring
 * Retry-After when present). Keeps one slow or rate-limited store from hanging a
 * whole sync. Used by the Apple review + iTunes Lookup calls.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 2;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }
      return res;
    } catch (err) {
      // Network error / timeout (AbortError) — retry a couple of times.
      lastErr = err;
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Request failed");
}

/**
 * Retry a promise-returning op while `shouldRetry(err)` holds, with capped
 * exponential backoff. Used for non-fetch clients (e.g. googleapis), where each
 * attempt keeps its own per-call timeout.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  opts: { retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < retries && shouldRetry(err)) {
        await sleep(Math.min(500 * 2 ** attempt, 8_000));
        continue;
      }
      throw err;
    }
  }
}

function retryDelayMs(res: Response, attempt: number): number {
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 10_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
