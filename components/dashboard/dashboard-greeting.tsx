"use client"

import * as React from "react"
import { motion } from "framer-motion"
import { IconSparkles } from "@tabler/icons-react"

const FUN_LINES = [
  "Let's turn that backlog into a highlight reel.",
  "Small steps today, big wins tomorrow.",
  "Your future self is already thanking you.",
  "Ship it — the board won't clear itself.",
  "Coffee's optional, momentum isn't.",
  "One ticket at a time. That's the whole secret.",
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
  name: string | null
  openTickets: number
  agendaEvents: number
}

export function DashboardGreeting({ name, openTickets, agendaEvents }: Props) {
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
    ? now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
    : " "

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="relative overflow-hidden rounded-2xl border border-white/10 px-6 py-6 text-white shadow-lg sm:px-8 sm:py-7"
      style={{
        backgroundColor: "#0b1020",
        backgroundImage:
          "radial-gradient(120% 140% at 0% 0%, var(--primary) 0%, transparent 45%), radial-gradient(120% 140% at 100% 0%, #8b5cf6 0%, transparent 42%)",
      }}
    >
      {/* floating glow orbs */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-full bg-fuchsia-500/30 blur-3xl"
        animate={{ y: [0, 12, 0], opacity: [0.5, 0.8, 0.5] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -bottom-12 left-1/3 h-44 w-44 rounded-full bg-sky-400/20 blur-3xl"
        animate={{ y: [0, -10, 0] }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="relative flex flex-col gap-5 @2xl/main:flex-row @2xl/main:items-center @2xl/main:justify-between">
        <div className="flex flex-col gap-2">
          <span className="w-fit rounded-full bg-white/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-white/80 backdrop-blur">
            {dateLabel}
          </span>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            {greeting.text}
            {name ? `, ${name}` : ""}{" "}
            <motion.span
              className="inline-block"
              animate={{ rotate: [0, 16, -8, 16, 0] }}
              transition={{ duration: 1.6, repeat: Infinity, repeatDelay: 2.5 }}
              style={{ transformOrigin: "70% 70%" }}
            >
              {greeting.emoji}
            </motion.span>
          </h1>
          <p className="flex items-center gap-1.5 text-sm text-white/85">
            <IconSparkles className="size-4 text-yellow-300" />
            {line}
          </p>
        </div>

        <div className="flex gap-3">
          <div className="flex min-w-28 flex-col rounded-xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-md">
            <span className="text-3xl font-bold tabular-nums leading-none">{openTickets}</span>
            <span className="mt-1 text-xs text-white/75">Your open tickets</span>
          </div>
          <div className="flex min-w-28 flex-col rounded-xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-md">
            <span className="text-3xl font-bold tabular-nums leading-none">{agendaEvents}</span>
            <span className="mt-1 text-xs text-white/75">Agenda events</span>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
