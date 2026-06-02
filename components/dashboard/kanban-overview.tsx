"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from "recharts"
import { IconCalendarEvent, IconTicket } from "@tabler/icons-react"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"

export type KanbanSlice = { status: string; count: number; colorKey: string }

// Map board column color keys to concrete chart colors.
const COLOR_BY_KEY: Record<string, string> = {
  slate: "#64748b",
  gray: "#64748b",
  neutral: "#64748b",
  zinc: "#71717a",
  stone: "#78716c",
  blue: "#3b82f6",
  info: "#3b82f6",
  sky: "#0ea5e9",
  cyan: "#06b6d4",
  indigo: "#6366f1",
  violet: "#8b5cf6",
  purple: "#8b5cf6",
  amber: "#f59e0b",
  warning: "#f59e0b",
  yellow: "#eab308",
  orange: "#f97316",
  emerald: "#10b981",
  success: "#10b981",
  green: "#22c55e",
  teal: "#14b8a6",
  red: "#ef4444",
  error: "#ef4444",
  rose: "#f43f5e",
  pink: "#ec4899",
}

function colorFor(key: string) {
  return COLOR_BY_KEY[key?.toLowerCase()] ?? "var(--chart-1)"
}

const chartConfig = {
  count: { label: "Tickets" },
} satisfies ChartConfig

export function KanbanOverview({
  data,
  totalTickets,
  agendaEvents,
}: {
  data: KanbanSlice[]
  totalTickets: number
  agendaEvents: number
}) {
  const chartData = React.useMemo(
    () => data.map((slice) => ({ ...slice, fill: colorFor(slice.colorKey) })),
    [data],
  )

  return (
    <Card className="@container/card" style={{ marginInline: "calc(var(--spacing) * 6)" }}>
      <CardHeader>
        <CardTitle>Kanban Overview</CardTitle>
        <CardDescription>
          Tickets across your board columns right now
        </CardDescription>
        <CardAction>
          <div className="flex gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm">
              <IconTicket className="size-4 text-muted-foreground" />
              <span className="font-semibold tabular-nums">{totalTickets}</span>
              <span className="hidden text-muted-foreground @[420px]/card:inline">tickets</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm">
              <IconCalendarEvent className="size-4 text-muted-foreground" />
              <span className="font-semibold tabular-nums">{agendaEvents}</span>
              <span className="hidden text-muted-foreground @[420px]/card:inline">events</span>
            </div>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {chartData.length === 0 ? (
          <Empty className="min-h-[250px] rounded-md bg-muted/10">
            <EmptyHeader>
              <EmptyTitle>No columns yet</EmptyTitle>
              <EmptyDescription>
                Create a board with columns to see your kanban breakdown.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
            <BarChart
              data={chartData}
              margin={{ top: 16, right: 8, left: 8, bottom: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="status"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                interval={0}
                tickFormatter={(value: string) =>
                  value.length > 12 ? `${value.slice(0, 11)}…` : value
                }
              />
              <YAxis hide allowDecimals={false} />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent hideIndicator />}
              />
              <Bar dataKey="count" radius={[6, 6, 0, 0]} maxBarSize={72}>
                <LabelList
                  dataKey="count"
                  position="top"
                  className="fill-foreground"
                  fontSize={12}
                />
                {chartData.map((entry) => (
                  <Cell key={entry.status} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
