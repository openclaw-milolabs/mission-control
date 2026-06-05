"use client";

import { IconStarFilled, IconBrandApple, IconBrandGooglePlay } from "@tabler/icons-react";

export type ReviewRow = {
  id: string;
  store: string;
  author: string | null;
  rating: number | null;
  title: string | null;
  body: string | null;
  app_version: string | null;
  country: string | null;
  submitted_at: string | null;
  store_response: string | null;
  sentiment: string | null;
  themes: string[] | null;
};

function Stars({ n }: { n: number | null }) {
  const count = Math.max(0, Math.min(5, Math.round(n ?? 0)));
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <IconStarFilled
          key={i}
          className={i < count ? "size-3.5 text-amber-500" : "size-3.5 text-muted-foreground/30"}
        />
      ))}
    </span>
  );
}

export function ReviewCard({ review }: { review: ReviewRow }) {
  const StoreIcon = review.store === "apple" ? IconBrandApple : IconBrandGooglePlay;
  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <StoreIcon className="size-4 text-muted-foreground" />
          <Stars n={review.rating} />
          <span className="font-medium">{review.title || "—"}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          {review.submitted_at ? new Date(review.submitted_at).toLocaleDateString() : ""}
        </div>
      </div>
      {review.body ? <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{review.body}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {review.author ? <span>{review.author}</span> : null}
        {review.app_version ? <span>· v{review.app_version}</span> : null}
        {review.country ? <span>· {review.country.toUpperCase()}</span> : null}
        {review.sentiment ? (
          <span className="rounded bg-muted px-1.5 py-0.5 capitalize">{review.sentiment}</span>
        ) : null}
      </div>
      {review.store_response ? (
        <div className="mt-2 rounded border-l-2 border-primary/50 bg-muted/40 p-2 text-xs">
          <span className="font-medium">Developer response: </span>
          {review.store_response}
        </div>
      ) : null}
    </div>
  );
}
