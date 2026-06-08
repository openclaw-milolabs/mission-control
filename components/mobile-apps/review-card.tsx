"use client";

import { useState } from "react";
import {
  IconStarFilled,
  IconBrandApple,
  IconBrandGooglePlay,
  IconLanguage,
  IconExternalLink,
} from "@tabler/icons-react";
import { formatDate } from "@/lib/format-date";
import { toAlpha2, territoryToLanguage } from "@/lib/mobile-apps/country-codes";
import { toast } from "sonner";

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
        <IconStarFilled key={i} className={i < count ? "size-3 text-amber-500" : "size-3 text-foreground/15"} />
      ))}
    </span>
  );
}

/** Best-effort link to the review on the store. Per-review deep links aren't
 * public, so this opens the app's reviews page on the right storefront. */
function storeUrl(review: ReviewRow, storeAppId: string | null): string | null {
  if (!storeAppId) return null;
  if (review.store === "apple") {
    const cc = toAlpha2(review.country) ?? "us";
    return `https://apps.apple.com/${cc}/app/id${storeAppId}?see-all=reviews`;
  }
  const hl = (review.language || "en").toLowerCase();
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(storeAppId)}&hl=${hl}&showAllReviews=true`;
}

export function ReviewCard({ review, storeAppId }: { review: ReviewRow; storeAppId?: string | null }) {
  const StoreIcon = review.store === "apple" ? IconBrandApple : IconBrandGooglePlay;
  const [expanded, setExpanded] = useState(false);
  const [translated, setTranslated] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [translating, setTranslating] = useState(false);

  const source = review.language?.toLowerCase() || territoryToLanguage(review.country) || "en";
  const canTranslate = source !== "nl";
  const url = storeUrl(review, storeAppId ?? null);

  const originalBody = review.body ?? "";
  const shownBody = translated && !showOriginal ? translated : originalBody;
  const long = shownBody.length > 280;

  async function translate() {
    if (translated) {
      setShowOriginal((v) => !v);
      return;
    }
    setTranslating(true);
    try {
      const text = [review.title, review.body].filter(Boolean).join("\n\n");
      const res = await fetch("/api/mobile-apps/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, source }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Translation failed");
      setTranslated(json.text as string);
      setShowOriginal(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Translation failed");
    } finally {
      setTranslating(false);
    }
  }

  return (
    <article className="py-6">
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

      {shownBody ? (
        <p
          className={`mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground/80 ${
            !expanded && long ? "line-clamp-4" : ""
          }`}
        >
          {shownBody}
        </p>
      ) : null}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        {long ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-primary transition-opacity hover:opacity-70"
          >
            {expanded ? "Show less" : "Read more"}
          </button>
        ) : null}
        {canTranslate ? (
          <button
            onClick={() => void translate()}
            disabled={translating}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-70 disabled:opacity-50"
          >
            <IconLanguage className="size-3.5" />
            {translating ? "Translating…" : translated ? (showOriginal ? "Show Dutch" : "Show original") : "Translate to Dutch"}
          </button>
        ) : null}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <IconExternalLink className="size-3.5" />
            View in store
          </a>
        ) : null}
      </div>

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
