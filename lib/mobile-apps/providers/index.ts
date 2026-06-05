import type { ReviewProvider, Store } from "@/lib/mobile-apps/types";
import { AppleProvider } from "@/lib/mobile-apps/providers/apple";
import { GoogleProvider } from "@/lib/mobile-apps/providers/google";

const apple = new AppleProvider();
const google = new GoogleProvider();

/** Returns the provider for a store. Swapping in official APIs later = change here only. */
export function getProvider(store: Store): ReviewProvider {
  return store === "apple" ? apple : google;
}
