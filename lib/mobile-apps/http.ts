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
        await delay(retryDelayMs(res, attempt));
        continue;
      }
      return res;
    } catch (err) {
      // Network error / timeout (AbortError) — retry a couple of times.
      lastErr = err;
      if (attempt < retries) {
        await delay(300 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Request failed");
}

function retryDelayMs(res: Response, attempt: number): number {
  const ra = Number(res.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 10_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
