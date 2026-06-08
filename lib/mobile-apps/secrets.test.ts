import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMobileReviewsConfig, loadSecretsEnv } from "@/lib/mobile-apps/config";

const TEST_KEY = "MOBILE_REVIEWS_SECRET_LOAD_PROBE";

afterEach(() => {
  delete process.env[TEST_KEY];
});

describe("secrets loading", () => {
  it("loadSecretsEnv merges process.env (proves the secrets loader runs)", () => {
    process.env[TEST_KEY] = "probe-value";
    expect(loadSecretsEnv()[TEST_KEY]).toBe("probe-value");
  });

  it("loadMobileReviewsConfig returns a well-formed config object", () => {
    const cfg = loadMobileReviewsConfig();
    expect(cfg).toHaveProperty("google.enabled");
    expect(cfg).toHaveProperty("apple.enabled");
    expect(cfg.sync.maxPages).toBeGreaterThan(0);
  });
});

describe("secrets.env is gitignored", () => {
  it(".gitignore ignores secrets.env but allows the example", () => {
    const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^secrets\.env$/m);
    expect(gitignore).toMatch(/^!secrets\.env\.example$/m);
  });

  it("a real secrets.env.example exists with placeholders only", () => {
    const example = readFileSync(join(process.cwd(), "secrets.env.example"), "utf8");
    expect(example).toMatch(/GOOGLE_PLAY_ENABLED=/);
    expect(example).toMatch(/APPSTORE_CONNECT_ISSUER_ID=replace_me/);
    // No obviously-real key material in the example.
    expect(example).not.toMatch(/BEGIN PRIVATE KEY/);
  });
});
