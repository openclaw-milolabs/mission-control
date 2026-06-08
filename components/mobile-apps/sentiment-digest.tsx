"use client";

import { IconSparkles, IconThumbDown, IconThumbUp } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { parseDigest } from "@/lib/mobile-apps/digest-parse";
import { formatDate } from "@/lib/format-date";

type Props = {
  summaryMd: string | null;
  createdAt: string | null;
  busy: boolean;
  onGenerate: () => void;
};

function scoreTone(score: number): { label: string; cls: string } {
  if (score >= 0.25) return { label: "Positive", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" };
  if (score <= -0.25) return { label: "Negative", cls: "bg-red-500/15 text-red-700 dark:text-red-400" };
  return { label: "Mixed", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-500" };
}

export function SentimentDigest({ summaryMd, createdAt, busy, onGenerate }: Props) {
  const d = summaryMd ? parseDigest(summaryMd) : null;

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <IconSparkles className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">AI sentiment</h2>
        </div>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onGenerate} disabled={busy}>
          {busy ? "Analyzing…" : d ? "Regenerate" : "Generate"}
        </Button>
      </div>

      {!d ? (
        <p className="text-sm text-muted-foreground">
          Summarize what reviewers are saying, the top complaints, and the praise. Runs on your recent reviews.
        </p>
      ) : (
        <div className="space-y-3.5">
          <div className="flex items-start gap-2.5">
            {d.score != null ? (
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${scoreTone(d.score).cls}`}>
                {scoreTone(d.score).label} {d.score > 0 ? `+${d.score.toFixed(1)}` : d.score.toFixed(1)}
              </span>
            ) : null}
            <p className="text-sm leading-relaxed text-foreground/85">{d.sentiment}</p>
          </div>

          {d.complaints.length > 0 ? (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <IconThumbDown className="size-3.5 text-red-500" /> Top complaints
              </div>
              <ul className="space-y-1">
                {d.complaints.slice(0, 5).map((c, i) => (
                  <li key={i} className="flex gap-2 text-sm text-foreground/80">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-red-500/70" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {d.praise.length > 0 ? (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <IconThumbUp className="size-3.5 text-emerald-500" /> Top praise
              </div>
              <ul className="space-y-1">
                {d.praise.slice(0, 5).map((c, i) => (
                  <li key={i} className="flex gap-2 text-sm text-foreground/80">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-emerald-500/70" />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {d.themes.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {d.themes.map((t) => (
                <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                  {t}
                </span>
              ))}
            </div>
          ) : null}

          {createdAt ? (
            <p className="text-[11px] text-muted-foreground/70">Generated {formatDate(createdAt)}</p>
          ) : null}
        </div>
      )}
    </section>
  );
}
