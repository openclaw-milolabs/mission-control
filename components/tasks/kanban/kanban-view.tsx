"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  closestCorners,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useState } from "react";
import { type Assignee, type BoardState, type Ticket } from "@/types/tasks";
import { KanbanColumn } from "./kanban-column";
import { TicketCard } from "../shared/ticket-card";
import { Card, CardContent } from "@/components/ui/card";
import { GhostIcon } from "lucide-react";

type Props = {
  board: BoardState;
  assigneeById: Record<string, Assignee>;
  labelById?: Record<string, import("@/types/tasks").Label>;
  visibleTicketIdsByColumn: Record<string, string[]>;
  onAddTask: (statusId: string) => void;
  canDeleteList: (columnId: string) => boolean;
  onDeleteList: (columnId: string) => void;
  onTicketClick: (ticketId: string) => void;
  onTicketCopy: (ticketId: string) => void;
  onTicketDelete: (ticketId: string) => void;
  moveColumn: (activeId: string, overId: string) => void;
  moveTicket: (
    ticketId: string,
    fromColumnId: string,
    toColumnId: string,
    toIndex: number,
    persist?: boolean,
    persistFromColumnId?: string,
  ) => void;
};

export function KanbanView({
  board,
  assigneeById,
  visibleTicketIdsByColumn,
  labelById,
  onAddTask,
  canDeleteList,
  onDeleteList,
  onTicketClick,
  onTicketCopy,
  onTicketDelete,
  moveColumn,
  moveTicket,
}: Props) {
  const [activeTicket, setActiveTicket] = useState<Ticket | null>(null);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const [dragStartTicketColumnId, setDragStartTicketColumnId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const getColumnIdFromOver = (overId: string, overData: Record<string, unknown> | undefined): string | null => {
    if (overData?.type === "ticket") {
      return overData.columnId as string;
    }

    if (overData?.type === "column" || board.columns[overId]) {
      return overId;
    }

    const sortableContainerId = overData?.sortable && typeof overData.sortable === "object"
      ? (overData.sortable as { containerId?: unknown }).containerId
      : undefined;

    if (typeof sortableContainerId === "string" && board.columns[sortableContainerId]) {
      return sortableContainerId;
    }

    return null;
  };

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const data = active.data.current;
    if (data?.type === "ticket") {
      setActiveTicket(board.tickets[active.id as string] ?? null);
      setDragStartTicketColumnId(data.columnId as string);
    } else if (data?.type === "column") {
      setActiveColumnId(active.id as string);
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current as Record<string, unknown> | undefined;

    if (activeData?.type !== "ticket") return;

    const ticketId = active.id as string;
    const fromColumnId = activeData.columnId as string;

    // Determine target column
    const toColumnId = getColumnIdFromOver(over.id as string, overData);

    if (!toColumnId || fromColumnId === toColumnId) return;

    // Move ticket across columns immediately so the visual updates
    const toIndex = board.ticketIdsByColumn[toColumnId]?.length ?? 0;
    moveTicket(ticketId, fromColumnId, toColumnId, toIndex, false);

    // Update the active data reference
    if (activeData) activeData.columnId = toColumnId;
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over) {
      setActiveTicket(null);
      setActiveColumnId(null);
      setDragStartTicketColumnId(null);
      return;
    }

    const activeData = active.data.current;
    const overData = over.data.current as Record<string, unknown> | undefined;

    if (activeData?.type === "column") {
      const overId = over.id as string;
      const overColumnId = getColumnIdFromOver(overId, overData);

      if (overColumnId && active.id !== overColumnId) {
        moveColumn(active.id as string, overColumnId);
      }
    }

    if (activeData?.type === "ticket") {
      const toColumnId = getColumnIdFromOver(over.id as string, overData);
      const currentColumnId = activeData.columnId as string;
      const sourceColumnId = dragStartTicketColumnId ?? currentColumnId;
      const persistFromColumnId = sourceColumnId !== toColumnId ? sourceColumnId : undefined;

      if (toColumnId && overData?.type === "ticket" && active.id !== over.id) {
        const ids = board.ticketIdsByColumn[toColumnId] ?? [];
        const toIndex = ids.indexOf(over.id as string);
        if (toIndex >= 0) {
          moveTicket(
            active.id as string,
            currentColumnId,
            toColumnId,
            toIndex,
            true,
            persistFromColumnId,
          );
        }
      } else if (toColumnId) {
        const ids = board.ticketIdsByColumn[toColumnId] ?? [];
        const currentIndex = ids.indexOf(active.id as string);
        const toIndex = currentIndex >= 0 ? currentIndex : ids.length;
        moveTicket(
          active.id as string,
          currentColumnId,
          toColumnId,
          toIndex,
          true,
          persistFromColumnId,
        );
      }
    }

    setActiveTicket(null);
    setActiveColumnId(null);
    setDragStartTicketColumnId(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        const pointerCollisions = pointerWithin(args);
        return pointerCollisions.length > 0 ? pointerCollisions : closestCorners(args);
      }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={board.columnOrder} strategy={horizontalListSortingStrategy}>
        <div className="flex gap-3 h-full overflow-x-auto pb-4 px-1 pt-1">
          {board.columnOrder.map((colId) => {
            const column = board.columns[colId];
            if (!column) return null;
            const visibleIds = visibleTicketIdsByColumn[colId] ?? [];
            const tickets = visibleIds.map((id) => board.tickets[id]).filter(Boolean) as Ticket[];

            return (
              <KanbanColumn
                key={colId}
                column={column}
                tickets={tickets}
                allTicketIds={visibleIds}
                assigneeById={assigneeById}
                labelById={labelById}
                isActive={activeColumnId === colId}
                onAddTask={() => onAddTask(colId)}
                canDeleteList={canDeleteList(colId)}
                onDeleteList={() => void onDeleteList(colId)}
                onTicketClick={onTicketClick}
                onTicketCopy={onTicketCopy}
                onTicketDelete={onTicketDelete}
              />
            );
          })}
        </div>
      </SortableContext>

      <DragOverlay dropAnimation={{ duration: 150, easing: "ease" }}>
        {activeTicket ? (
          <div className="w-72 rotate-1 shadow-2xl opacity-90">
            <TicketCard ticket={activeTicket} assigneeById={assigneeById} labelById={labelById} onClick={() => {}} />
          </div>
        ) : activeColumnId ? (
          <div className="w-72 rotate-1 shadow-2xl opacity-95">
            <Card className="overflow-hidden py-0">
              <CardContent className="border-b bg-muted/30 p-3">
                <span className="text-sm font-semibold">
                  {board.columns[activeColumnId]?.title}
                </span>
              </CardContent>
              <CardContent className="flex flex-col gap-2 p-2">
                {(visibleTicketIdsByColumn[activeColumnId] ?? [])
                  .slice(0, 3)
                  .map((id) => board.tickets[id])
                  .filter(Boolean)
                  .map((ticket) => (
                    <TicketCard
                      key={ticket.id}
                      ticket={ticket}
                      assigneeById={assigneeById}
                labelById={labelById}
                      dense
                      onClick={() => {}}
                    />
                  ))}
                {(visibleTicketIdsByColumn[activeColumnId] ?? []).length === 0 && (
                  <div className="flex min-h-24 flex-col items-center justify-center rounded-md border-2 border-dashed border-border/60 px-4 py-6 text-center text-muted-foreground">
                    <div className="mb-2 rounded-full bg-muted/60 p-2">
                      <GhostIcon className="h-4 w-4" />
                    </div>
                    <p className="text-sm font-medium text-foreground/80">No tickets here</p>
                    <p className="mt-1 text-xs">Drop a ticket into this list to start working.</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
