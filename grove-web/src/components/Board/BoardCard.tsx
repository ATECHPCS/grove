// A single board card. Anatomy mirrors Dorothy: project chip, title, branch,
// diff stats, and an agent affordance (green pulse when working, amber pill
// when the agent is waiting on the user).

import { GitBranch, Bot } from "lucide-react";
import type { BoardCardData } from "./types";

interface BoardCardProps {
  card: BoardCardData;
  /** TODO/PLANNED cards are user-draggable; IN WORK/COMPLETED are locked. */
  draggable: boolean;
  onDragStart: (e: React.DragEvent, taskId: string) => void;
  onDragEnd: () => void;
  /** True while a stage/start mutation for this card is in flight. */
  pending?: boolean;
}

export function BoardCard({
  card,
  draggable,
  onDragStart,
  onDragEnd,
  pending,
}: BoardCardProps) {
  const { task, projectName, live } = card;
  const additions = task.additions ?? 0;
  const deletions = task.deletions ?? 0;
  const filesChanged = task.filesChanged ?? 0;
  const hasDiff = additions > 0 || deletions > 0 || filesChanged > 0;

  const working = live === "busy";
  const waiting = live === "permission";

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, task.id)}
      onDragEnd={onDragEnd}
      className={[
        "group relative rounded-xl p-3 select-none",
        "bg-[var(--color-bg-secondary)] border border-[var(--color-border)]",
        "shadow-sm transition-all",
        draggable ? "cursor-grab active:cursor-grabbing hover:border-[var(--color-text-muted)]" : "cursor-default",
        working ? "ring-1 ring-emerald-500/40" : "",
        waiting ? "ring-1 ring-amber-500/50" : "",
        pending ? "opacity-60" : "",
      ].join(" ")}
    >
      {/* Working accent rail */}
      {working && (
        <span className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full bg-emerald-500 animate-pulse" />
      )}

      {/* Header: project chip + agent affordance */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] max-w-[60%] truncate">
          {projectName || "project"}
        </span>
        {working && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Working
          </span>
        )}
        {waiting && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold text-amber-950 bg-amber-400">
            Needs input
          </span>
        )}
      </div>

      {/* Title */}
      <div className="text-sm font-medium text-[var(--color-text)] leading-snug line-clamp-2 mb-1.5">
        {task.name}
      </div>

      {/* Footer: branch + diff stats + agent glyph */}
      <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        {task.branch && !task.isLocal && (
          <span className="inline-flex items-center gap-1 min-w-0">
            <GitBranch className="w-3 h-3 shrink-0" />
            <span className="truncate max-w-[120px]">{task.branch}</span>
          </span>
        )}
        {hasDiff && (
          <span className="inline-flex items-center gap-1.5 shrink-0">
            {additions > 0 && <span className="text-emerald-400">+{additions}</span>}
            {deletions > 0 && <span className="text-red-400">-{deletions}</span>}
            {filesChanged > 0 && (
              <span className="text-[var(--color-text-muted)]">
                {filesChanged}f
              </span>
            )}
          </span>
        )}
        {(working || waiting) && (
          <Bot
            className={[
              "w-3.5 h-3.5 ml-auto shrink-0",
              working ? "text-emerald-400" : "text-amber-400",
            ].join(" ")}
          />
        )}
      </div>
    </div>
  );
}
