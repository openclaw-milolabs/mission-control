import assert from "node:assert/strict";
import { resolveListing } from "../../lib/mobile-apps/resolve.ts";

// Apple URL with country + numeric id
let r = resolveListing("https://apps.apple.com/nl/app/whatsapp-messenger/id310633997");
assert.equal(r.store, "apple");
assert.equal(r.storeAppId, "310633997");
assert.equal(r.country, "nl");

// Apple URL without country defaults to us
r = resolveListing("https://apps.apple.com/app/id310633997");
assert.equal(r.store, "apple");
assert.equal(r.storeAppId, "310633997");
assert.equal(r.country, "us");

// Google Play URL with hl/gl
r = resolveListing("https://play.google.com/store/apps/details?id=com.whatsapp&hl=en&gl=NL");
assert.equal(r.store, "google");
assert.equal(r.storeAppId, "com.whatsapp");
assert.equal(r.country, "nl");

// Bare numeric id -> apple
r = resolveListing("310633997");
assert.equal(r.store, "apple");
assert.equal(r.storeAppId, "310633997");

// Bare package id -> google
r = resolveListing("com.whatsapp");
assert.equal(r.store, "google");
assert.equal(r.storeAppId, "com.whatsapp");

// Garbage throws
assert.throws(() => resolveListing("not a url or id"));

// Google Play URL with a #fragment must NOT pollute the id
r = resolveListing("https://play.google.com/store/apps/details?id=com.whatsapp#reviews");
assert.equal(r.store, "google");
assert.equal(r.storeAppId, "com.whatsapp");

// Empty / whitespace-only input throws
assert.throws(() => resolveListing(""));
assert.throws(() => resolveListing("   "));

console.log("ok - resolveListing");
