import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const reportsSrc = readFileSync(
  join(process.cwd(), "lib/mobile-apps/providers/google-play-reports.ts"),
  "utf8",
);

describe("Google Cloud Storage access is strictly read-only", () => {
  it("never uploads, creates buckets, copies, or uses BigQuery", () => {
    for (const forbidden of [
      ".upload(",
      ".save(",
      "createBucket",
      ".copy(",
      "createWriteStream",
      "makePublic",
      "bigquery",
      "BigQuery",
    ]) {
      expect(reportsSrc).not.toContain(forbidden);
    }
  });

  it("requests only the devstorage.read_only scope", () => {
    expect(reportsSrc).toContain("devstorage.read_only");
    expect(reportsSrc).toContain(".download()");
  });
});

describe("dependencies", () => {
  it("declares @google-cloud/storage", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@google-cloud/storage"]).toBeTruthy();
  });
});
