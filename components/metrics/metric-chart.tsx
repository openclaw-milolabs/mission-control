"use client";

import { useMemo } from "react";
import {
  Area, AreaChart,
  Bar, BarChart,
  Line, LineChart,
  Pie, PieChart, Cell,
  CartesianGrid, XAxis, YAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";

type Row = Record<string, unknown>;

type Props = {
  type: "bar" | "line" | "area" | "pie" | "donut" | "kpi";
  xColumn: string;
  yColumns: string[];
  rows: Row[];
};

// Colours come from the global shadcn chart palette (--chart-1..5 in globals.css)
// so charts inherit the active accent the user picked in Appearance.
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function coerceNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function buildConfig(yColumns: string[]): ChartConfig {
  const config: ChartConfig = {};
  yColumns.forEach((col, i) => {
    config[col] = {
      label: col,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    };
  });
  return config;
}

export function MetricChart({ type, xColumn, yColumns, rows }: Props) {
  const data = useMemo(() => {
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => {
      const out: Record<string, unknown> = { [xColumn]: r[xColumn] };
      for (const col of yColumns) out[col] = coerceNumber(r[col]);
      return out;
    });
  }, [rows, xColumn, yColumns]);

  const config = useMemo(() => buildConfig(yColumns), [yColumns]);

  if (!rows || rows.length === 0) {
    return (
      <div className="flex h-full min-h-[180px] items-center justify-center text-xs text-muted-foreground">
        No rows to render.
      </div>
    );
  }

  if (type === "kpi") {
    const firstY = yColumns[0];
    if (!firstY) {
      return (
        <div className="flex h-full min-h-[180px] items-center justify-center text-xs text-destructive">
          KPI needs a Y column.
        </div>
      );
    }
    // Sum the y column across all rows for a single-number display.
    const total = data.reduce((acc, r) => acc + coerceNumber(r[firstY]), 0);
    const delta = data.length > 1
      ? coerceNumber(data[data.length - 1][firstY]) - coerceNumber(data[0][firstY])
      : 0;
    return (
      <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 text-center">
        <div className="tabular-nums text-4xl font-bold tracking-tight" style={{ color: SERIES_COLORS[0] }}>
          {total.toLocaleString()}
        </div>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{firstY}</div>
        {data.length > 1 && (
          <div className={`text-[11px] tabular-nums ${delta >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
            {delta >= 0 ? "+" : ""}{delta.toLocaleString()} from first to last
          </div>
        )}
      </div>
    );
  }

  if (type === "pie" || type === "donut") {
    const firstY = yColumns[0];
    if (!firstY) {
      return (
        <div className="flex h-full min-h-[180px] items-center justify-center text-xs text-destructive">
          Pie / donut needs a Y column.
        </div>
      );
    }
    const pieData = data.map((r, i) => ({
      name: String(r[xColumn] ?? ""),
      value: coerceNumber(r[firstY]),
      fill: SERIES_COLORS[i % SERIES_COLORS.length],
    }));
    return (
      <ChartContainer config={config} className="h-[260px] w-full">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent />} />
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            innerRadius={type === "donut" ? 60 : 0}
            outerRadius={100}
            strokeWidth={1}
          >
            {pieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
          </Pie>
          <ChartLegend content={<ChartLegendContent />} />
        </PieChart>
      </ChartContainer>
    );
  }

  if (type === "line") {
    return (
      <ChartContainer config={config} className="h-[260px] w-full">
        <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey={xColumn} tickLine={false} axisLine={false} tickMargin={6} fontSize={10} />
          <YAxis tickLine={false} axisLine={false} tickMargin={6} fontSize={10} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {yColumns.map((col, i) => (
            <Line
              key={col}
              type="monotone"
              dataKey={col}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
          {yColumns.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        </LineChart>
      </ChartContainer>
    );
  }

  if (type === "area") {
    return (
      <ChartContainer config={config} className="h-[260px] w-full">
        <AreaChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey={xColumn} tickLine={false} axisLine={false} tickMargin={6} fontSize={10} />
          <YAxis tickLine={false} axisLine={false} tickMargin={6} fontSize={10} />
          <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
          <defs>
            {yColumns.map((col, i) => (
              <linearGradient key={col} id={`mc-area-${col}-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.6} />
                <stop offset="95%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.05} />
              </linearGradient>
            ))}
          </defs>
          {yColumns.map((col, i) => (
            <Area
              key={col}
              type="monotone"
              dataKey={col}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              fill={`url(#mc-area-${col}-${i})`}
              strokeWidth={2}
              stackId={yColumns.length > 1 ? "1" : undefined}
            />
          ))}
          {yColumns.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        </AreaChart>
      </ChartContainer>
    );
  }

  // Default: bar chart
  return (
    <ChartContainer config={config} className="h-[260px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey={xColumn} tickLine={false} axisLine={false} tickMargin={6} fontSize={10} />
        <YAxis tickLine={false} axisLine={false} tickMargin={6} fontSize={10} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {yColumns.map((col, i) => (
          <Bar key={col} dataKey={col} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[4, 4, 0, 0]} />
        ))}
        {yColumns.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
      </BarChart>
    </ChartContainer>
  );
}
