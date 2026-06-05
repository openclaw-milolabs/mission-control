import assert from "node:assert/strict";
import { buildDigestPrompt } from "../../lib/mobile-apps/digest.ts";

const prompt = buildDigestPrompt("Demo App", [
  { store: "apple", rating: 5, title: "Great", body: "Love   it\nso much", submitted_at: "2026-06-01T00:00:00Z" },
  { store: "google", rating: 1, title: null, body: null, submitted_at: "2026-05-01T00:00:00Z" },
]);
assert.ok(prompt.includes('"Demo App"'));
assert.ok(prompt.includes("## Overall sentiment"));
assert.ok(prompt.includes("[apple] 5★ Great: Love it so much")); // whitespace collapsed
assert.ok(prompt.includes("[google] 1★ ")); // null title/body handled
// empty review list yields the placeholder
const empty = buildDigestPrompt("X", []);
assert.ok(empty.includes("(no recent reviews)"));
console.log("ok - buildDigestPrompt");
