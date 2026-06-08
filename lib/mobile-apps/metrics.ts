/**
 * Pure metrics helpers. All ratings/averages are computed from the reviews we
 * actually fetched via the official APIs (the publisher APIs do not expose a
 * store-wide aggregate), which is exactly what the dashboard advertises.
 */

export type RatedReview = { rating: number | null };
export type DatedReview = RatedReview & { submittedAt: string | null };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type ReviewSummary = {
  avgRating: number | null;
  ratingsCount: number;
  histogram: Record<string, number>;
};

/** Average, count, and a 1..5 histogram from fetched reviews. */
export function summarizeReviews(reviews: RatedReview[]): ReviewSummary {
  const histogram: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let sum = 0;
  let count = 0;
  for (const r of reviews) {
    const rating = r.rating;
    if (rating == null || !Number.isFinite(rating)) continue;
    const bucket = Math.min(5, Math.max(1, Math.round(rating)));
    histogram[String(bucket)] += 1;
    sum += rating;
    count += 1;
  }
  return {
    avgRating: count === 0 ? null : round2(sum / count),
    ratingsCount: count,
    histogram,
  };
}

/** Number of rated reviews at or below the negative threshold. */
export function countNegative(reviews: RatedReview[], threshold: number): number {
  let n = 0;
  for (const r of reviews) {
    if (r.rating != null && Number.isFinite(r.rating) && r.rating <= threshold) n += 1;
  }
  return n;
}

function isoWeekLabel(d: Date): string {
  // ISO 8601 week: Thursday-anchored.
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type TrendPoint = { period: string; avg: number; count: number };

/** Average rating bucketed by UTC day or ISO week, sorted ascending. */
export function averageRatingTrend(reviews: DatedReview[], granularity: "day" | "week"): TrendPoint[] {
  const buckets = new Map<string, { sum: number; count: number }>();
  for (const r of reviews) {
    if (r.rating == null || !Number.isFinite(r.rating) || !r.submittedAt) continue;
    const d = new Date(r.submittedAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = granularity === "day" ? d.toISOString().slice(0, 10) : isoWeekLabel(d);
    const b = buckets.get(key) ?? { sum: 0, count: 0 };
    b.sum += r.rating;
    b.count += 1;
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, b]) => ({ period, avg: round2(b.sum / b.count), count: b.count }));
}
