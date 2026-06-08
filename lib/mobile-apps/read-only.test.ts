import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const moduleRoot = join(process.cwd(), "lib/mobile-apps");
const allModuleSrc = existsSync(moduleRoot)
  ? walk(moduleRoot)
      .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
      .map((p) => readFileSync(p, "utf8"))
      .join("\n")
  : "";

const reportsSrc = readFileSync(
  join(process.cwd(), "lib/mobile-apps/providers/google-play-reports.ts"),
  "utf8",
);

describe("Google Cloud Storage access is strictly read-only", () => {
  it("never uploads, creates buckets, copies, writes streams, or uses BigQuery anywhere in mobile-apps", () => {
    // Actual write/usage calls (not the word in a documenting comment).
    for (const forbidden of [
      ".upload(",
      ".save(",
      "file.save(",
      "bucket.create(",
      "createBucket(",
      "storage.createBucket(",
      ".copy(",
      "createWriteStream(",
      "makePublic(",
      "@google-cloud/bigquery",
      "new BigQuery(",
    ]) {
      expect(allModuleSrc).not.toContain(forbidden);
    }
  });

  it("requests only the devstorage.read_only scope and downloads reports", () => {
    expect(reportsSrc).toContain("devstorage.read_only");
    expect(reportsSrc).toContain(".download()");
  });
});

describe("Google Play write/reply endpoints are not used", () => {
  it("does not call reviews.reply or App Store customerReviewResponses write endpoints", () => {
    expect(allModuleSrc).not.toContain("reviews.reply(");
    expect(allModuleSrc).not.toMatch(/customerReviewResponses.*method:\s*["']POST/i);
    expect(allModuleSrc).not.toMatch(/customerReviewResponses.*method:\s*["']PATCH/i);
    expect(allModuleSrc).not.toMatch(/customerReviewResponses.*method:\s*["']DELETE/i);
  });
});

describe("dependencies", () => {
  it("declares @google-cloud/storage", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@google-cloud/storage"] ?? pkg.devDependencies?.["@google-cloud/storage"]).toBeTruthy();
  });
});
