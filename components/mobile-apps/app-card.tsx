"use client";

import Link from "next/link";
import { IconBrandApple, IconBrandGooglePlay, IconChevronRight } from "@tabler/icons-react";

export type AppListing = {
  id: string;
  store: string;
  storeAppId: string;
  country: string;
  currentRating: number | null;
  ratingsCount: number | null;
  lastSyncedAt: string | null;
};

export type AppSummary = {
  id: string;
  name: string;
  icon_url: string | null;
  notes: string | null;
  listings: AppListing[];
};

/**
 * Store presence badge for the list. Intentionally shows NO rating: a single
 * headline rating per store is overloaded/ambiguous (Apple per-country vs Google
 * report avg vs written-review avg) and misleads in a list. Ratings live on the
 * app detail page where each number is labeled with its source.
 */
function StoreBadge({ listing }: { listing: AppListing }) {
  const Icon = listing.store === "apple" ? IconBrandApple : IconBrandGooglePlay;
  const label = listing.store === "apple" ? "App Store" : "Google Play";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground">
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

export function AppCard({ app }: { app: AppSummary }) {
  return (
    <Link
      href={`/mobile-apps/${app.id}`}
      className="group flex items-center gap-4 rounded-xl border bg-card px-4 py-3.5 transition-all hover:border-foreground/15 hover:shadow-sm"
    >
      {app.icon_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={app.icon_url} alt="" className="size-11 shrink-0 rounded-xl border" />
      ) : (
        <div className="grid size-11 shrink-0 place-items-center rounded-xl border bg-muted text-sm font-semibold text-muted-foreground">
          {app.name.slice(0, 1).toUpperCase()}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{app.name}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {app.listings.length > 0 ? `${app.listings.length} store ${app.listings.length === 1 ? "listing" : "listings"}` : "No listings"}
        </div>
      </div>

      <div className="hidden items-center gap-2 sm:flex">
        {app.listings.map((l) => (
          <StoreBadge key={l.id} listing={l} />
        ))}
      </div>

      <IconChevronRight className="size-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
