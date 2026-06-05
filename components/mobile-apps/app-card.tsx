"use client";

import Link from "next/link";
import {
  IconBrandApple,
  IconBrandGooglePlay,
  IconStarFilled,
} from "@tabler/icons-react";

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

function StoreBadge({ listing }: { listing: AppListing }) {
  const Icon =
    listing.store === "apple" ? IconBrandApple : IconBrandGooglePlay;
  return (
    <div className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
      <Icon className="size-3.5" />
      <IconStarFilled className="size-3 text-amber-500" />
      <span className="font-medium">
        {listing.currentRating?.toFixed(2) ?? "—"}
      </span>
      <span className="text-muted-foreground">
        ({listing.ratingsCount?.toLocaleString() ?? "—"})
      </span>
    </div>
  );
}

export function AppCard({ app }: { app: AppSummary }) {
  return (
    <Link
      href={`/mobile-apps/${app.id}`}
      className="block rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40"
    >
      <div className="flex items-center gap-3">
        {app.icon_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={app.icon_url} alt="" className="size-12 rounded-lg" />
        ) : (
          <div className="size-12 rounded-lg bg-muted" />
        )}
        <div className="min-w-0">
          <div className="truncate font-semibold">{app.name}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {app.listings.map((l) => (
              <StoreBadge key={l.id} listing={l} />
            ))}
          </div>
        </div>
      </div>
    </Link>
  );
}
