"use client";

import { IconStarFilled } from "@tabler/icons-react";

/** Horizontal 1..5 star distribution with counts and share. */
export function RatingDistribution({ counts }: { counts: [number, number, number, number, number] }) {
  // counts is indexed 0->1star .. 4->5star
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-1.5">
      {[5, 4, 3, 2, 1].map((star) => {
        const value = counts[star - 1] ?? 0;
        const pct = total === 0 ? 0 : (value / total) * 100;
        return (
          <div key={star} className="flex items-center gap-2.5 text-xs">
            <span className="flex w-6 items-center gap-0.5 tabular-nums text-muted-foreground">
              {star}
              <IconStarFilled className="size-2.5 text-amber-500/70" />
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-amber-500 transition-[width] duration-500 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-10 text-right tabular-nums text-muted-foreground">{value.toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
