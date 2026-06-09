import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/modules/state", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/local-db", () => ({ getSql: vi.fn(() => () => Promise.resolve([])) }));

import { getSession } from "@/lib/auth/session";
import { isModuleEnabled } from "@/lib/modules/state";
import { GET } from "@/app/api/mobile-apps/stream/route";

const req = () => new Request("http://localhost/api/mobile-apps/stream");

beforeEach(() => vi.mocked(isModuleEnabled).mockResolvedValue(true));
afterEach(() => vi.clearAllMocks());

describe("SSE /api/mobile-apps/stream auth gate", () => {
  it("rejects unauthenticated requests with 401 (no open DB LISTEN)", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("rejects when the module is disabled with 503", async () => {
    vi.mocked(getSession).mockResolvedValue({ sub: "s", name: "n", email: "u@example.com" });
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    const res = await GET(req());
    expect(res.status).toBe(503);
  });
});
