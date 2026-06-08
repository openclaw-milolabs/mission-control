import { describe, expect, it } from "vitest";
import { parseMobileReviewsConfig, publicConfigStatus } from "@/lib/mobile-apps/config";

const base = {
  GOOGLE_PLAY_ENABLED: "false",
  APPSTORE_CONNECT_ENABLED: "false",
};

describe("parseMobileReviewsConfig - google", () => {
  it("marks google disabled when not enabled", () => {
    const cfg = parseMobileReviewsConfig(base);
    expect(cfg.google.enabled).toBe(false);
    expect(cfg.google.configured).toBe(false);
  });

  it("is enabled-but-not-configured when service account is missing", () => {
    const cfg = parseMobileReviewsConfig({
      ...base,
      GOOGLE_PLAY_ENABLED: "true",
      GOOGLE_PLAY_PACKAGE_NAME: "com.example.app",
    });
    expect(cfg.google.enabled).toBe(true);
    expect(cfg.google.configured).toBe(false);
    expect(cfg.google.error).toMatch(/GOOGLE_PLAY_SERVICE_ACCOUNT/);
  });

  it("is configured with package name + json path, replies off by default", () => {
    const cfg = parseMobileReviewsConfig({
      ...base,
      GOOGLE_PLAY_ENABLED: "true",
      GOOGLE_PLAY_PACKAGE_NAME: "com.example.app",
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH: "/abs/sa.json",
    });
    expect(cfg.google.configured).toBe(true);
    expect(cfg.google.error).toBeNull();
    expect(cfg.google.packageName).toBe("com.example.app");
  });
});

describe("parseMobileReviewsConfig - apple", () => {
  it("treats replace_me placeholders as not configured", () => {
    const cfg = parseMobileReviewsConfig({
      ...base,
      APPSTORE_CONNECT_ENABLED: "true",
      APPSTORE_CONNECT_ISSUER_ID: "replace_me",
      APPSTORE_CONNECT_KEY_ID: "replace_me",
      APPSTORE_CONNECT_APP_ID: "replace_me",
      APPSTORE_CONNECT_PRIVATE_KEY_PATH: "/abs/key.p8",
    });
    expect(cfg.apple.enabled).toBe(true);
    expect(cfg.apple.configured).toBe(false);
    expect(cfg.apple.error).toBeTruthy();
  });

  it("is configured when all apple fields present", () => {
    const cfg = parseMobileReviewsConfig({
      ...base,
      APPSTORE_CONNECT_ENABLED: "true",
      APPSTORE_CONNECT_ISSUER_ID: "iss-123",
      APPSTORE_CONNECT_KEY_ID: "KEY123",
      APPSTORE_CONNECT_APP_ID: "9999",
      APPSTORE_CONNECT_PRIVATE_KEY_PATH: "/abs/key.p8",
    });
    expect(cfg.apple.configured).toBe(true);
    expect(cfg.apple.error).toBeNull();
  });
});

describe("parseMobileReviewsConfig - sync", () => {
  it("applies defaults when sync vars absent", () => {
    const cfg = parseMobileReviewsConfig(base);
    expect(cfg.sync.maxPages).toBe(10);
    expect(cfg.sync.concurrency).toBe(2);
    expect(cfg.sync.negativeThreshold).toBe(3);
  });

  it("parses provided sync values", () => {
    const cfg = parseMobileReviewsConfig({
      ...base,
      MOBILE_REVIEWS_SYNC_MAX_PAGES: "5",
      MOBILE_REVIEWS_SYNC_CONCURRENCY: "4",
      MOBILE_REVIEWS_NEGATIVE_THRESHOLD: "2",
    });
    expect(cfg.sync.maxPages).toBe(5);
    expect(cfg.sync.concurrency).toBe(4);
    expect(cfg.sync.negativeThreshold).toBe(2);
  });
});

describe("publicConfigStatus", () => {
  it("exposes only enabled/configured/error - never secrets", () => {
    const cfg = parseMobileReviewsConfig({
      ...base,
      GOOGLE_PLAY_ENABLED: "true",
      GOOGLE_PLAY_PACKAGE_NAME: "com.secret.app",
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH: "/abs/secret-path.json",
      APPSTORE_CONNECT_ENABLED: "true",
      APPSTORE_CONNECT_ISSUER_ID: "iss-secret",
      APPSTORE_CONNECT_KEY_ID: "KEYSECRET",
      APPSTORE_CONNECT_APP_ID: "9999",
      APPSTORE_CONNECT_PRIVATE_KEY_PATH: "/abs/secret-key.p8",
    });
    const status = publicConfigStatus(cfg);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toMatch(/secret-path/);
    expect(serialized).not.toMatch(/secret-key/);
    expect(serialized).not.toMatch(/KEYSECRET/);
    expect(serialized).not.toMatch(/iss-secret/);
    expect(status.google).toEqual({ enabled: true, configured: true, error: null });
    expect(status.apple).toEqual({ enabled: true, configured: true, error: null });
  });
});
