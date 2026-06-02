"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { IconArrowRight, IconCircleCheckFilled } from "@tabler/icons-react"

import { formatDue } from "@/types/tasks"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export type DashboardTask = {
  id: string
  title: string
  status: string
  colorKey: string
  priority: string
  dueDate: string | null
  done: boolean
  boardId: string
  boardName: string
}

const PRIORITY_CLASS: Record<string, string> = {
  urgent: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  high: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
}

const DOT_BY_KEY: Record<string, string> = {
  blue: "bg-blue-500",
  info: "bg-blue-500",
  amber: "bg-amber-500",
  warning: "bg-amber-500",
  emerald: "bg-emerald-500",
  success: "bg-emerald-500",
  green: "bg-emerald-500",
  red: "bg-red-500",
  violet: "bg-violet-500",
  purple: "bg-violet-500",
}

function dueTone(dueDate: string | null) {
  if (!dueDate) return "text-muted-foreground"
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(`${dueDate}T00:00:00`)
  if (due < today) return "text-red-600 dark:text-red-400 font-medium"
  if (due.getTime() === today.getTime()) return "text-amber-600 dark:text-amber-400 font-medium"
  return "text-muted-foreground"
}

export function DashboardTasksTable({ tasks }: { tasks: DashboardTask[] }) {
  const router = useRouter()

  const goToTicket = React.useCallback(
    (task: DashboardTask) => {
      router.push(`/boards?board=${task.boardId}&ticket=${task.id}`)
    },
    [router],
  )

  return (
    <Card className="mx-4 lg:mx-6">
      <CardHeader className="border-b">
        <CardTitle>Your Tasks</CardTitle>
        <CardDescription>Open tickets that need your attention, soonest due first</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => router.push("/boards")}>
            View boards
            <IconArrowRight />
          </Button>
        </CardAction>
      </CardHeader>
      {tasks.length === 0 ? (
        <div className="px-4 lg:px-6">
          <Empty className="min-h-36 rounded-md bg-muted/10">
            <EmptyHeader>
              <EmptyTitle>All clear 🎉</EmptyTitle>
              <EmptyDescription>
                No open tickets right now. Create one from Boards to get rolling.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <div className="overflow-x-auto px-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead className="hidden sm:table-cell">Board</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Priority</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => (
                <TableRow
                  key={task.id}
                  className="group cursor-pointer"
                  onClick={() => goToTicket(task)}
                >
                  <TableCell className="max-w-[280px] truncate font-medium">
                    {task.done && (
                      <IconCircleCheckFilled className="mr-1 inline size-4 text-emerald-500" />
                    )}
                    {task.title}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                    {task.boardName}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="px-1.5 text-muted-foreground">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${DOT_BY_KEY[task.colorKey?.toLowerCase()] ?? "bg-muted-foreground"}`}
                      />
                      {task.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge
                      variant="outline"
                      className={`px-1.5 capitalize ${PRIORITY_CLASS[task.priority] ?? "text-muted-foreground"}`}
                    >
                      {task.priority}
                    </Badge>
                  </TableCell>
                  <TableCell className={`whitespace-nowrap text-xs ${dueTone(task.dueDate)}`}>
                    {task.dueDate ? formatDue(task.dueDate) : "—"}
                  </TableCell>
                  <TableCell>
                    <IconArrowRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}
