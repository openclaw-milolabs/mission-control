"use client"

import * as React from "react"
import { IconSparkles } from "@tabler/icons-react"

const FUN_LINES = [
  "Let's turn that backlog into a highlight reel.",
  "Small steps today, big wins tomorrow.",
  "Your future self is already thanking you.",
  "Ship it. The board won't clear itself.",
  "Coffee's optional, momentum isn't.",
  "One ticket at a time — that's the whole secret.",
  "Make today's standup a victory lap.",
  "Plot twist: you're going to crush this.",
]

function greetingFor(hour: number) {
  if (hour < 5) return { text: "Working late", emoji: "🌙" }
  if (hour < 12) return { text: "Good morning", emoji: "☀️" }
  if (hour < 18) return { text: "Good afternoon", emoji: "👋" }
  if (hour < 22) return { text: "Good evening", emoji: "🌆" }
  return { text: "Burning the midnight oil", emoji: "🌙" }
}

type Props = {
  openTickets: number
  agendaEvents: number
}

export function DashboardGreeting({ openTickets, agendaEvents }: Props) {
  // Resolve client-local time after mount to avoid SSR/hydration mismatch.
  const [now, setNow] = React.useState<Date | null>(null)
  const [line, setLine] = React.useState(FUN_LINES[0])

  React.useEffect(() => {
    setNow(new Date())
    setLine(FUN_LINES[Math.floor(Math.random() * FUN_LINES.length)])
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  const greeting = greetingFor(now?.getHours() ?? 9)
  const dateLabel = now
    ? now.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : " "

  return (
    <div className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-primary/15 via-primary/5 to-card px-5 py-5 shadow-xs sm:px-7 sm:py-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-primary/20 blur-3xl"
      />
      <div className="relative flex flex-col gap-4 @2xl/main:flex-row @2xl/main:items-center @2xl/main:justify-between">
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {dateLabel}
          </p>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            <span>{greeting.text}</span>
            <span className="text-2xl sm:text-3xl">{greeting.emoji}</span>
          </h1>
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <IconSparkles className="size-4 text-primary" />
            {line}
          </p>
        </div>
        <div className="flex gap-3">
          <div className="flex min-w-24 flex-col rounded-lg border bg-background/60 px-4 py-3 backdrop-blur">
            <span className="text-2xl font-semibold tabular-nums">{openTickets}</span>
            <span className="text-xs text-muted-foreground">Open tickets</span>
          </div>
          <div className="flex min-w-24 flex-col rounded-lg border bg-background/60 px-4 py-3 backdrop-blur">
            <span className="text-2xl font-semibold tabular-nums">{agendaEvents}</span>
            <span className="text-xs text-muted-foreground">Agenda events</span>
          </div>
        </div>
      </div>
    </div>
  )
}
