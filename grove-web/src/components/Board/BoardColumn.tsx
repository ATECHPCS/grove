// A board column: header with accent rule + count, and a droppable card list.
// TODO/PLANNED accept drops; IN WORK/COMPLETED are lifecycle-only (locked).

import type { BoardCardData, ColumnDef, ColumnId } from "./types";
import { BoardCard } from "./BoardCard";

const ACCENT_RULE: Record<ColumnDef["accent"], string> = {
  zinc: "bg-zinc-500/60",
  blue: "bg-blue-500/70",
  amber: "bg-amber-500/70",
  emerald: "bg-emerald-500/70",
};

const ACCENT_TEXT: Record<ColumnDef["accent"], string> = {
  zinc: "text-zinc-400",
  blue: "text-blue-400",
  amber: "text-amber-400",
  emerald: "text-emerald-400",
};

interface BoardColumnProps {
  def: ColumnDef;
  cards: BoardCardData[];
  isDropTarget: boolean;
  pendingTaskId: string | null;
  onDragStart: (e: React.DragEvent, taskId: string, projectId: string) => void;
  onDragEnd: () => void;
  onDragOverColumn: (e: React.DragEvent, column: ColumnId) => void;
  onDragLeaveColumn: (column: ColumnId) => void;
  onDropColumn: (e: React.DragEvent, column: ColumnId) => void;
  /** Open a card's live workspace on click. */
  onOpenCard?: (taskId: string, isLocal: boolean, projectId: string) => void;
}

export function BoardColumn({
  def,
  cards,
  isDropTarget,
  pendingTaskId,
  onDragStart,
  onDragEnd,
  onDragOverColumn,
  onDragLeaveColumn,
  onDropColumn,
  onOpenCard,
}: BoardColumnProps) {
  return (
    <div className="flex flex-col min-w-0 flex-1 basis-0">
      {/* Header */}
      <div className="px-1 pb-2">
        <div className={`h-0.5 w-full rounded-full ${ACCENT_RULE[def.accent]} mb-2`} />
        <div className="flex items-center justify-between">
          <span className={`text-xs font-semibold uppercase tracking-wide ${ACCENT_TEXT[def.accent]}`}>
            {def.label}
          </span>
          <span className="text-xs font-medium text-[var(--color-text-muted)] tabular-nums">
            {cards.length}
          </span>
        </div>
      </div>

      {/* Droppable body */}
      <div
        onDragOver={def.droppable ? (e) => onDragOverColumn(e, def.id) : undefined}
        onDragLeave={def.droppable ? () => onDragLeaveColumn(def.id) : undefined}
        onDrop={def.droppable ? (e) => onDropColumn(e, def.id) : undefined}
        className={[
          "flex-1 min-h-0 overflow-y-auto rounded-xl p-2 space-y-2 transition-colors",
          "border border-dashed",
          isDropTarget
            ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
            : "border-transparent",
          !def.droppable ? "bg-[var(--color-bg)]/40" : "",
        ].join(" ")}
      >
        {cards.map((card) => (
          <BoardCard
            key={`${card.projectId}:${card.task.id}`}
            card={card}
            draggable={def.droppable}
            pending={pendingTaskId === `${card.projectId}:${card.task.id}`}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onOpen={onOpenCard}
          />
        ))}
        {cards.length === 0 && (
          <div className="flex items-center justify-center h-16 text-[11px] text-[var(--color-text-muted)]/60 select-none">
            {def.droppable ? "Drop here" : "—"}
          </div>
        )}
      </div>
    </div>
  );
}
