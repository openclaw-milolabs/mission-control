"use client"

import * as React from "react"
import { CartesianGrid, Line, LineChart, XAxis } from "recharts"

import { useIsMobile } from "@/hooks/use-mobile"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export type OverviewPoint = {
  date: string
  created: number
  completed: number
  events: number
}

type View = "kanban" | "agenda"

const chartConfig = {
  created: { label: "Created", color: "var(--chart-1)" },
  completed: { label: "Completed", color: "var(--chart-2)" },
  events: { label: "Events", color: "var(--chart-3)" },
} satisfies ChartConfig

function toDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`)
}

export function KanbanOverview({
  data,
  totalTickets,
  agendaEvents,
}: {
  data: OverviewPoint[]
  totalTickets: number
  agendaEvents: number
}) {
  const isMobile = useIsMobile()
  const [view, setView] = React.useState<View>("kanban")
  const [timeRange, setTimeRange] = React.useState("30d")

  React.useEffect(() => {
    if (isMobile) setTimeRange("7d")
  }, [isMobile])

  const filteredData = React.useMemo(() => {
    const lastPoint = data[data.length - 1]
    const referenceDate = lastPoint ? toDate(lastPoint.date) : new Date()
    let daysToSubtract = 90
    if (timeRange === "30d") daysToSubtract = 30
    else if (timeRange === "7d") daysToSubtract = 7

    const startDate = new Date(referenceDate)
    startDate.setUTCDate(startDate.getUTCDate() - daysToSubtract)
    return data.filter((point) => toDate(point.date) >= startDate)
  }, [data, timeRange])

  const isKanban = view === "kanban"

  return (
    <Card className="@container/card" style={{ marginInline: "calc(var(--spacing) * 6)" }}>
      <CardHeader>
        <CardTitle>{isKanban ? "Kanban Overview" : "Agenda Overview"}</CardTitle>
        <CardDescription>
          {isKanban
            ? `${totalTickets} tickets total · created vs completed over time`
            : `${agendaEvents} agenda events total · scheduled over time`}
        </CardDescription>
        <CardAction>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(v) => v && setView(v as View)}
              variant="outline"
              className="*:data-[slot=toggle-group-item]:px-3!"
            >
              <ToggleGroupItem value="kanban">Kanban</ToggleGroupItem>
              <ToggleGroupItem value="agenda">Agenda</ToggleGroupItem>
            </ToggleGroup>
            <ToggleGroup
              type="single"
              value={timeRange}
              onValueChange={(v) => v && setTimeRange(v)}
              variant="outline"
              className="hidden *:data-[slot=toggle-group-item]:px-4! @[767px]/card:flex"
            >
              <ToggleGroupItem value="90d">Last 3 months</ToggleGroupItem>
              <ToggleGroupItem value="30d">Last 30 days</ToggleGroupItem>
              <ToggleGroupItem value="7d">Last 7 days</ToggleGroupItem>
            </ToggleGroup>
            <Select value={timeRange} onValueChange={setTimeRange}>
              <SelectTrigger
                className="flex w-36 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
                size="sm"
                aria-label="Select time range"
              >
                <SelectValue placeholder="Last 30 days" />
              </SelectTrigger>
              <SelectContent className="rounded-xl">
                <SelectItem value="90d" className="rounded-lg">Last 3 months</SelectItem>
                <SelectItem value="30d" className="rounded-lg">Last 30 days</SelectItem>
                <SelectItem value="7d" className="rounded-lg">Last 7 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
          <LineChart data={filteredData} margin={{ left: 12, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value) =>
                toDate(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })
              }
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(value) =>
                    toDate(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                  }
                  indicator="dot"
                />
              }
            />
            {isKanban ? (
              <>
                <Line
                  dataKey="created"
                  type="monotone"
                  stroke="var(--color-created)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  dataKey="completed"
                  type="monotone"
                  stroke="var(--color-completed)"
                  strokeWidth={2}
                  dot={false}
                />
              </>
            ) : (
              <Line
                dataKey="events"
                type="monotone"
                stroke="var(--color-events)"
                strokeWidth={2}
                dot={false}
              />
            )}
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
