import { describe, expect, it } from "vitest";
import { parseDigest } from "@/lib/mobile-apps/digest-parse";

const md = `## Overall sentiment
Users are mostly frustrated since the latest update. Score: -0.3

## Top complaints
- Crashes on launch
- Sync is slow

## Top praise
- Clean interface
- Fast support

## Notable themes
crashes, performance, ui`;

describe("parseDigest", () => {
  it("extracts sentiment text, score, complaints, praise, and themes", () => {
    const d = parseDigest(md);
    expect(d.sentiment).toMatch(/frustrated/);
    expect(d.score).toBe(-0.3);
    expect(d.complaints).toEqual(["Crashes on launch", "Sync is slow"]);
    expect(d.praise).toEqual(["Clean interface", "Fast support"]);
    expect(d.themes).toEqual(["crashes", "performance", "ui"]);
  });

  it("degrades gracefully on unstructured text", () => {
    const d = parseDigest("Just a sentence with no structure.");
    expect(d.sentiment).toMatch(/no structure/);
    expect(d.score).toBeNull();
    expect(d.complaints).toEqual([]);
    expect(d.praise).toEqual([]);
    expect(d.themes).toEqual([]);
  });

  it("handles empty input", () => {
    const d = parseDigest("");
    expect(d.sentiment).toBe("");
    expect(d.score).toBeNull();
  });
});
