"use client";

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { IconChartLine } from "@tabler/icons-react";

export type TrendPoint = { day: string; avg: number; count: number };
/** A real release date + label, snapped to the nearest plotted day for placement. */
export type TrendMarker = { day: string; label: string };

function fmtDay(day: string): string {
  const d = new Date(day);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Snap each marker's real date to the closest plotted day (categorical axis needs
 *  an exact category to position on). Markers outside the data window are dropped. */
function snapMarkers(markers: TrendMarker[], data: TrendPoint[]): Array<{ day: string; label: string }> {
  if (data.length === 0) return [];
  const times = data.map((d) => ({ day: d.day, t: new Date(d.day).getTime() }));
  const min = times[0].t;
  const max = times[times.length - 1].t;
  const out: Array<{ day: string; label: string }> = [];
  for (const m of markers) {
    const mt = new Date(m.day).getTime();
    if (!Number.isFinite(mt) || mt < min || mt > max) continue;
    let best = times[0];
    for (const c of times) if (Math.abs(c.t - mt) < Math.abs(best.t - mt)) best = c;
    out.push({ day: best.day, label: m.label });
  }
  return out;
}

export function RatingTrend({ data, markers = [] }: { data: TrendPoint[]; markers?: TrendMarker[] }) {
  const gradientId = useId().replace(/:/g, "");
  const snapped = snapMarkers(markers, data);

  if (data.length < 2) {
    return (
      <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
        <IconChartLine className="size-5 text-muted-foreground/50" />
        <p className="max-w-[14rem] text-xs text-muted-foreground">
          Not enough dated reviews yet to plot a trend. It fills in as more reviews arrive.
        </p>
      </div>
    );
  }

  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -22 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.5} />
          <XAxis
            dataKey="day"
            tickFormatter={fmtDay}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          />
          <YAxis
            domain={[1, 5]}
            ticks={[1, 2, 3, 4, 5]}
            tickLine={false}
            axisLine={false}
            width={28}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
          />
          <Tooltip
            cursor={{ stroke: "var(--border)" }}
            contentStyle={{
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--popover)",
              fontSize: 12,
              boxShadow: "0 4px 16px oklch(0 0 0 / 0.12)",
            }}
            labelFormatter={(l) => fmtDay(String(l))}
            formatter={(value: number | string, _n, item) => [
              `${Number(value).toFixed(2)}★ · ${(item?.payload as TrendPoint)?.count ?? 0} reviews`,
              "Avg rating",
            ]}
          />
          <Area
            type="monotone"
            dataKey="avg"
            stroke="var(--chart-1)"
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
          />
          {snapped.map((m, i) => (
            <ReferenceLine
              key={`${m.day}-${i}`}
              x={m.day}
              stroke="var(--muted-foreground)"
              strokeDasharray="3 3"
              strokeOpacity={0.6}
              label={{ value: m.label, position: "top", fontSize: 9, fill: "var(--muted-foreground)" }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
