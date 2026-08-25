// Board (Kanban) mode — top-level page.
//
// Renders the current project's tasks as cards across four columns. Users drag
// cards between TODO and PLANNED; dropping a not-yet-started card into PLANNED
// dispatches an agent (POST /tasks/{id}/start). IN WORK and COMPLETED are
// lifecycle-driven (live agent status / merge), not manual drop targets.
// Live updates arrive via the shared Radio socket (useBoardTasks).

import { useCallback, useMemo, useRef, useState } from "react";
import { SquareKanban, Plus, Loader2, X } from "lucide-react";
import { dispatchTask, moveTaskStage, startTask } from "../../api";
import { useBoardTasks } from "./useBoardTasks";
import { BoardColumn } from "./BoardColumn";
import { BOARD_COLUMNS, type BoardCardData, type ColumnId } from "./types";

const DRAG_MIME = "application/x-grove-task";

interface BoardPageProps {
  /** Open a task's live workspace (chat / terminal / diff) when its card is clicked. */
  onOpenTask?: (taskId: string, isLocal: boolean) => void;
}

export function BoardPage({ onOpenTask }: BoardPageProps = {}) {
  const {
    byColumn,
    cards,
    isLoading,
    projectId,
    projectName,
    isStudio,
    refresh,
    applyStage,
  } = useBoardTasks();

  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<ColumnId | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [composerOpen, setComposerOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const composerRef = useRef<HTMLInputElement | null>(null);

  const cardsById = useMemo(() => {
    const m = new Map<string, BoardCardData>();
    for (const c of cards) m.set(c.task.id, c);
    return m;
  }, [cards]);

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const onDragStart = useCallback((e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData(DRAG_MIME, taskId);
    e.dataTransfer.setData("text/plain", taskId);
    e.dataTransfer.effectAllowed = "move";
    setDraggingTaskId(taskId);
  }, []);

  const onDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    setDragOverColumn(null);
  }, []);

  const onDragOverColumn = useCallback((e: React.DragEvent, column: ColumnId) => {
    // Only meaningful while a card is being dragged.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverColumn((prev) => (prev === column ? prev : column));
  }, []);

  const onDragLeaveColumn = useCallback((column: ColumnId) => {
    setDragOverColumn((prev) => (prev === column ? null : prev));
  }, []);

  const onDropColumn = useCallback(
    async (e: React.DragEvent, target: ColumnId) => {
      e.preventDefault();
      const taskId = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData("text/plain");
      setDragOverColumn(null);
      setDraggingTaskId(null);
      if (!taskId || !projectId) return;

      const card = cardsById.get(taskId);
      if (!card || card.column === target) return;

      setPendingTaskId(taskId);
      setError(null);
      try {
        if (target === "planned") {
          const neverStarted =
            !card.live && (card.task.boardColumn ?? "todo") !== "planned";
          applyStage(taskId, "planned");
          if (neverStarted) {
            // Drop-to-PLANNED on a fresh card = dispatch an agent.
            const res = await startTask(projectId, taskId);
            if (!res.agent_started && res.agent_error) {
              setError(`Agent didn't start: ${res.agent_error}`);
            }
          } else {
            await moveTaskStage(projectId, taskId, "planned");
          }
        } else if (target === "todo") {
          applyStage(taskId, "todo");
          await moveTaskStage(projectId, taskId, "todo");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Move failed: ${msg}`);
        void refresh(); // reconcile optimistic state
      } finally {
        setPendingTaskId(null);
      }
    },
    [projectId, cardsById, applyStage, refresh],
  );

  // ── New card composer ──────────────────────────────────────────────────────
  const submitNewCard = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || !projectId || creating) return;
    setCreating(true);
    setError(null);
    try {
      // File a plain TODO card (no agent yet); drag it to PLANNED to start work.
      await dispatchTask(projectId, { title, auto_start: false, into: "todo" });
      setNewTitle("");
      setComposerOpen(false);
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Couldn't create card: ${msg}`);
    } finally {
      setCreating(false);
    }
  }, [newTitle, projectId, creating, refresh]);

  // ── Render guards ──────────────────────────────────────────────────────────
  if (!projectId) {
    return (
      <EmptyState
        title="No project selected"
        subtitle="Pick a project to see its board."
      />
    );
  }

  if (isStudio) {
    return (
      <EmptyState
        title="Board isn't available for Studio projects"
        subtitle="The board dispatches coding agents, which Studio projects don't run."
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <SquareKanban className="w-5 h-5 text-[var(--color-highlight)] shrink-0" />
          <h1 className="text-lg font-semibold tracking-tight truncate">Board</h1>
          {projectName && (
            <span className="text-sm text-[var(--color-text-muted)] truncate">
              · {projectName}
            </span>
          )}
          {isLoading && (
            <Loader2 className="w-4 h-4 text-[var(--color-text-muted)] animate-spin" />
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setComposerOpen(true);
            requestAnimationFrame(() => composerRef.current?.focus());
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--color-highlight)] text-[var(--color-bg)] hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" />
          New card
        </button>
      </header>

      {/* Composer */}
      {composerOpen && (
        <div className="flex items-center gap-2 px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <input
            ref={composerRef}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNewCard();
              if (e.key === "Escape") {
                setComposerOpen(false);
                setNewTitle("");
              }
            }}
            placeholder="Describe the task… (creates a To Do card)"
            className="flex-1 min-w-0 px-3 py-1.5 rounded-lg text-sm bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)]"
          />
          <button
            type="button"
            onClick={() => void submitNewCard()}
            disabled={!newTitle.trim() || creating}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--color-highlight)] text-[var(--color-bg)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : "Add"}
          </button>
          <button
            type="button"
            onClick={() => {
              setComposerOpen(false);
              setNewTitle("");
            }}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-3 px-6 py-2 text-sm text-[var(--color-error)] bg-[var(--color-error)]/10 border-b border-[var(--color-error)]/20">
          <span className="truncate">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="p-1 rounded hover:bg-[var(--color-error)]/10 shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Columns */}
      <div
        className={[
          "flex-1 min-h-0 grid gap-4 px-6 py-4",
          "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
          draggingTaskId ? "[&_*]:cursor-grabbing" : "",
        ].join(" ")}
      >
        {BOARD_COLUMNS.map((def) => (
          <BoardColumn
            key={def.id}
            def={def}
            cards={byColumn[def.id]}
            isDropTarget={def.droppable && dragOverColumn === def.id && !!draggingTaskId}
            pendingTaskId={pendingTaskId}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOverColumn={onDragOverColumn}
            onDragLeaveColumn={onDragLeaveColumn}
            onDropColumn={onDropColumn}
            onOpenCard={onOpenTask}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyState({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[60vh] bg-[var(--color-bg)] text-center px-6">
      <SquareKanban className="w-10 h-10 text-[var(--color-text-muted)] mb-3" />
      <h2 className="text-lg font-semibold text-[var(--color-text)] mb-1">{title}</h2>
      <p className="text-sm text-[var(--color-text-muted)] max-w-sm">{subtitle}</p>
    </div>
  );
}
