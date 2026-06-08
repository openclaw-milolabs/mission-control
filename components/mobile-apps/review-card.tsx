"use client";

import { useState } from "react";
import { IconStarFilled, IconBrandApple, IconBrandGooglePlay } from "@tabler/icons-react";
import { formatDate } from "@/lib/format-date";

export type ReviewRow = {
  id: string;
  store: string;
  author: string | null;
  rating: number | null;
  title: string | null;
  body: string | null;
  app_version: string | null;
  country: string | null;
  language?: string | null;
  submitted_at: string | null;
  store_response: string | null;
};

function Stars({ n }: { n: number | null }) {
  const count = Math.max(0, Math.min(5, Math.round(n ?? 0)));
  return (
    <span className="inline-flex items-center gap-px" aria-label={`${count} out of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <IconStarFilled
          key={i}
          className={i < count ? "size-3 text-amber-500" : "size-3 text-foreground/15"}
        />
      ))}
    </span>
  );
}

export function ReviewCard({ review }: { review: ReviewRow }) {
  const StoreIcon = review.store === "apple" ? IconBrandApple : IconBrandGooglePlay;
  const [expanded, setExpanded] = useState(false);
  const body = review.body ?? "";
  const long = body.length > 280;

  return (
    <article className="py-4 first:pt-0">
      <div className="flex items-center gap-2.5">
        <Stars n={review.rating} />
        {review.title ? (
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{review.title}</h3>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        <time className="shrink-0 text-xs text-muted-foreground" dateTime={review.submitted_at ?? undefined}>
          {formatDate(review.submitted_at)}
        </time>
      </div>

      {body ? (
        <p
          className={`mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground/80 ${
            !expanded && long ? "line-clamp-4" : ""
          }`}
        >
          {body}
        </p>
      ) : null}
      {long ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-medium text-primary transition-opacity hover:opacity-70"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <StoreIcon className="size-3.5" />
        {review.author ? <span className="font-medium text-foreground/65">{review.author}</span> : null}
        {review.app_version ? <span>v{review.app_version}</span> : null}
        {review.country ? <span className="uppercase">{review.country}</span> : null}
      </div>

      {review.store_response ? (
        <div className="mt-2.5 rounded-lg bg-muted/60 px-3 py-2.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Developer response
          </div>
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/75">{review.store_response}</p>
        </div>
      ) : null}
    </article>
  );
}
