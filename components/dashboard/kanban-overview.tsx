"use client"

import * as React from "react"
import { CartesianGrid, Line, LineChart, XAxis } from "recharts"
import { IconCalendarEvent, IconTicket } from "@tabler/icons-react"

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

export type OverviewPoint = { date: string; created: number; completed: number }

const chartConfig = {
  created: { label: "Created", color: "var(--chart-1)" },
  completed: { label: "Completed", color: "var(--chart-2)" },
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

  return (
    <Card className="@container/card" style={{ marginInline: "calc(var(--spacing) * 6)" }}>
      <CardHeader>
        <CardTitle>Kanban Overview</CardTitle>
        <CardDescription>
          <span className="hidden @[540px]/card:block">
            Tickets created and completed over time
          </span>
          <span className="@[540px]/card:hidden">Ticket activity</span>
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 @[640px]/card:flex">
              <div className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm">
                <IconTicket className="size-4 text-muted-foreground" />
                <span className="font-semibold tabular-nums">{totalTickets}</span>
              </div>
              <div className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm">
                <IconCalendarEvent className="size-4 text-muted-foreground" />
                <span className="font-semibold tabular-nums">{agendaEvents}</span>
              </div>
            </div>
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
                className="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
                size="sm"
                aria-label="Select a value"
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
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
