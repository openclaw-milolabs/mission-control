"use client";

import { useId } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { IconChartLine } from "@tabler/icons-react";

export type TrendPoint = { day: string; avg: number; count: number };

function fmtDay(day: string): string {
  const d = new Date(day);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function RatingTrend({ data }: { data: TrendPoint[] }) {
  const gradientId = useId().replace(/:/g, "");

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
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
