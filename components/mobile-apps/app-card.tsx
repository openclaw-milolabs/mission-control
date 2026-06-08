"use client";

import Link from "next/link";
import { IconBrandApple, IconBrandGooglePlay, IconChevronRight, IconStarFilled } from "@tabler/icons-react";

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

function StoreRating({ listing }: { listing: AppListing }) {
  const Icon = listing.store === "apple" ? IconBrandApple : IconBrandGooglePlay;
  const rating = listing.currentRating;
  const pct = rating != null ? (rating / 5) * 100 : 0;
  return (
    <div className="flex min-w-[7rem] items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex-1">
        <div className="flex items-baseline gap-1">
          <span className="text-sm font-semibold tabular-nums">{rating != null ? rating.toFixed(2) : "—"}</span>
          <IconStarFilled className="size-3 text-amber-500" />
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {listing.ratingsCount != null ? listing.ratingsCount.toLocaleString() : "—"}
          </span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-amber-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
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
          {app.listings.length > 0
            ? app.listings.map((l) => (l.store === "apple" ? "App Store" : "Google Play")).join(" · ")
            : "No listings"}
        </div>
      </div>

      <div className="hidden items-center gap-5 sm:flex">
        {app.listings.map((l) => (
          <StoreRating key={l.id} listing={l} />
        ))}
      </div>

      <IconChevronRight className="size-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
