import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "@/lib/mobile-apps/http";

afterEach(() => vi.restoreAllMocks());

describe("fetchWithRetry", () => {
  it("retries on 429 then returns the successful response", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const res = await fetchWithRetry("https://x", {}, { timeoutMs: 1000, retries: 1 });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and returns the last 429", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    const res = await fetchWithRetry("https://x", {}, { timeoutMs: 1000, retries: 1 });
    expect(res.status).toBe(429);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
