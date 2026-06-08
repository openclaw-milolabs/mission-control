import { describe, expect, it } from "vitest";
import { toAlpha2, flagEmoji, territoryToLanguage } from "@/lib/mobile-apps/country-codes";

describe("toAlpha2", () => {
  it("maps App Store alpha-3 territory codes to iTunes alpha-2 storefronts", () => {
    expect(toAlpha2("NLD")).toBe("nl");
    expect(toAlpha2("TUR")).toBe("tr");
    expect(toAlpha2("USA")).toBe("us");
    expect(toAlpha2("GBR")).toBe("gb");
    expect(toAlpha2("DEU")).toBe("de");
  });

  it("passes through alpha-2 codes (any case)", () => {
    expect(toAlpha2("nl")).toBe("nl");
    expect(toAlpha2("TR")).toBe("tr");
  });

  // Regression: these App Store Connect alpha-3 territories used to fall through
  // the partial map and render as raw "POL"/"BEL"/… rows duplicating the alpha-2
  // rating rows. The full ISO 3166-1 map must cover every real territory.
  it("maps every territory that previously duplicated in the by-country list", () => {
    expect(toAlpha2("POL")).toBe("pl");
    expect(toAlpha2("BEL")).toBe("be");
    expect(toAlpha2("ROU")).toBe("ro");
    expect(toAlpha2("RUS")).toBe("ru");
    expect(toAlpha2("SWE")).toBe("se");
  });

  it("returns null for unknown codes", () => {
    expect(toAlpha2("")).toBeNull();
    expect(toAlpha2("ZZZ")).toBeNull();
  });
});

describe("territoryToLanguage", () => {
  it("guesses a source language from a territory code", () => {
    expect(territoryToLanguage("TUR")).toBe("tr");
    expect(territoryToLanguage("NLD")).toBe("nl");
    expect(territoryToLanguage("USA")).toBe("en");
    expect(territoryToLanguage("gb")).toBe("en");
  });
  it("returns null for unknown territories", () => {
    expect(territoryToLanguage("ZZZ")).toBeNull();
  });
});

describe("flagEmoji", () => {
  it("builds a flag from an alpha-2 code", () => {
    expect(flagEmoji("nl")).toBe("🇳🇱");
    expect(flagEmoji("TR")).toBe("🇹🇷");
  });
  it("returns empty string for invalid input", () => {
    expect(flagEmoji("x")).toBe("");
  });
});
