import type { ReviewProvider, Store } from "@/lib/mobile-apps/types";
import { AppleProvider } from "@/lib/mobile-apps/providers/apple";
import { GoogleProvider } from "@/lib/mobile-apps/providers/google";

const apple = new AppleProvider();
const google = new GoogleProvider();

/** Returns the official-API provider for a store (Android Publisher / App Store Connect). */
export function getProvider(store: Store): ReviewProvider {
  return store === "apple" ? apple : google;
}
