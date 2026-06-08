import { describe, expect, it } from "vitest";
import { buildAgentEnv } from "@/lib/mobile-apps/digest";

describe("buildAgentEnv (digest agent gets no secrets)", () => {
  it("passes through only benign CLI vars and drops every secret", () => {
    const env = buildAgentEnv({
      PATH: "/usr/bin",
      HOME: "/home/clawdbot",
      NODE_ENV: "production",
      // secrets that must NOT reach the untrusted-input agent:
      DATABASE_URL: "postgres://secret",
      AUTH_SECRET: "shhh",
      OPENCLAW_GATEWAY_TOKEN: "tok",
      OPENCLAW_GATEWAY_URL: "https://gw",
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64: "abc",
      APPSTORE_CONNECT_PRIVATE_KEY_BASE64: "def",
      MYMEMORY_EMAIL: "a@b.c",
      OPENAI_API_KEY: "sk-xxx",
    } as NodeJS.ProcessEnv);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/clawdbot");
    expect(env.NODE_ENV).toBe("production");

    const serialized = JSON.stringify(env);
    for (const secret of [
      "DATABASE_URL", "AUTH_SECRET", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_URL",
      "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64", "APPSTORE_CONNECT_PRIVATE_KEY_BASE64",
      "MYMEMORY_EMAIL", "OPENAI_API_KEY",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
