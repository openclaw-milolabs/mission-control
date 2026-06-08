import { describe, expect, it } from "vitest";
import { getProvider } from "@/lib/mobile-apps/providers";

describe("getProvider", () => {
  it("returns a provider for known stores", () => {
    expect(getProvider("apple")).toBeTruthy();
    expect(getProvider("google")).toBeTruthy();
  });

  it("throws for an unknown store instead of defaulting to Google", () => {
    expect(() => getProvider("steam" as never)).toThrowError(/Unsupported mobile app store/);
  });
});
