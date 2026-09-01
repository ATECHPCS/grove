// Global Board mode — every project's tasks pooled into one Kanban board.
//
// The cross-project sibling of BoardPage: same four columns and the same
// BoardColumn/BoardCard rendering (cards already wear a project chip), but the
// data source spans all projects (useGlobalBoardTasks) and every mutation is
// routed to the project the dragged card belongs to. Optional project-filter
// chips narrow the view; the composer picks which project a new card lands in.

import { useCallback, useMemo, useRef, useState } from "react";
import { SquareKanban, Plus, Loader2, X } from "lucide-react";
import { dispatchTask, moveTaskStage, startTask } from "../../api";
import { BoardColumn } from "../Board/BoardColumn";
import { BOARD_COLUMNS, type BoardCardData, type ColumnId } from "../Board/types";
import { useGlobalBoardTasks } from "./useGlobalBoardTasks";

const DRAG_MIME = "application/x-grove-task";
const DRAG_PROJECT_MIME = "application/x-grove-project";

interface GlobalBoardPageProps {
  /** Open a task's live workspace (chat / terminal / diff) when its card is
   *  clicked. Carries the card's own projectId so the host can switch to that
   *  project before opening (cards span projects here). */
  onOpenTask?: (taskId: string, isLocal: boolean, projectId: string) => void;
}

const EMPTY_BY_COLUMN: Record<ColumnId, BoardCardData[]> = {
  todo: [],
  planned: [],
  ongoing: [],
  done: [],
};

export function GlobalBoardPage({ onOpenTask }: GlobalBoardPageProps = {}) {
  const { cards, projects, isLoading, error: loadError, refresh, applyStage } =
    useGlobalBoardTasks();

  // null = show all projects; otherwise only ids in the set.
  const [projectFilter, setProjectFilter] = useState<Set<string> | null>(null);

  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<ColumnId | null>(null);
  // Composite `${projectId}:${taskId}` so same-slug cards in other projects
  // don't share a pending highlight.
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Derive the *effective* filter each render by intersecting the user's raw
  // selection with the projects that currently exist. A project that vanished
  // (deleted / transiently failed to load) is simply ignored rather than
  // stranding the board on a permanently blank view; if it returns, so does
  // its card. An empty intersection collapses to "show all".
  const effectiveFilter = useMemo<Set<string> | null>(() => {
    if (!projectFilter) return null;
    const live = new Set(projects.map((p) => p.id));
    const next = new Set([...projectFilter].filter((id) => live.has(id)));
    return next.size === 0 ? null : next;
  }, [projectFilter, projects]);

  const [composerOpen, setComposerOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [composerProjectId, setComposerProjectId] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const composerRef = useRef<HTMLInputElement | null>(null);

  // Resolve a dragged card back to its origin project by composite key.
  const cardsByKey = useMemo(() => {
    const m = new Map<string, BoardCardData>();
    for (const c of cards) m.set(`${c.projectId}:${c.task.id}`, c);
    return m;
  }, [cards]);

  const visibleCards = useMemo(() => {
    if (!effectiveFilter) return cards;
    return cards.filter((c) => effectiveFilter.has(c.projectId));
  }, [cards, effectiveFilter]);

  const byColumn = useMemo<Record<ColumnId, BoardCardData[]>>(() => {
    const groups: Record<ColumnId, BoardCardData[]> = {
      todo: [],
      planned: [],
      ongoing: [],
      done: [],
    };
    for (const card of visibleCards) groups[card.column].push(card);
    for (const col of BOARD_COLUMNS) {
      groups[col.id].sort((a, b) => (a.task.boardOrder ?? 0) - (b.task.boardOrder ?? 0));
    }
    return groups;
  }, [visibleCards]);

  // ── Filter chips ───────────────────────────────────────────────────────────
  const toggleProject = useCallback((id: string) => {
    setProjectFilter((prev) => {
      // From "all", a click isolates the clicked project.
      if (!prev) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Empty selection == show all (avoids a blank board).
      return next.size === 0 ? null : next;
    });
  }, []);

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const onDragStart = useCallback(
    (e: React.DragEvent, taskId: string, projectId: string) => {
      e.dataTransfer.setData(DRAG_MIME, taskId);
      e.dataTransfer.setData(DRAG_PROJECT_MIME, projectId);
      e.dataTransfer.setData("text/plain", taskId);
      e.dataTransfer.effectAllowed = "move";
      setDraggingTaskId(taskId);
    },
    [],
  );

  const onDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    setDragOverColumn(null);
  }, []);

  const onDragOverColumn = useCallback((e: React.DragEvent, column: ColumnId) => {
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
      const projectId = e.dataTransfer.getData(DRAG_PROJECT_MIME);
      setDragOverColumn(null);
      setDraggingTaskId(null);
      if (!taskId || !projectId) return;

      const card = cardsByKey.get(`${projectId}:${taskId}`);
      if (!card || card.column === target) return;

      setPendingTaskId(`${projectId}:${taskId}`);
      setError(null);
      try {
        if (target === "planned") {
          const neverStarted =
            !card.live && (card.task.boardColumn ?? "todo") !== "planned";
          applyStage(projectId, taskId, "planned");
          if (neverStarted) {
            // Drop-to-PLANNED on a fresh card = dispatch an agent in its project.
            const res = await startTask(projectId, taskId);
            if (!res.agent_started && res.agent_error) {
              setError(`Agent didn't start: ${res.agent_error}`);
            }
          } else {
            await moveTaskStage(projectId, taskId, "planned");
          }
        } else if (target === "todo") {
          applyStage(projectId, taskId, "todo");
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
    [cardsByKey, applyStage, refresh],
  );

  // ── New card composer ──────────────────────────────────────────────────────
  const openComposer = useCallback(() => {
    // Default the picker to the first project (or the sole filtered one).
    setComposerProjectId((prev) => {
      if (prev && projects.some((p) => p.id === prev)) return prev;
      if (effectiveFilter && effectiveFilter.size === 1) {
        return [...effectiveFilter][0];
      }
      return projects[0]?.id ?? "";
    });
    setComposerOpen(true);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, [projects, effectiveFilter]);

  const submitNewCard = useCallback(async () => {
    const title = newTitle.trim();
    if (!title || !composerProjectId || creating) return;
    setCreating(true);
    setError(null);
    try {
      // File a plain TODO card (no agent yet); drag it to PLANNED to start work.
      await dispatchTask(composerProjectId, { title, auto_start: false, into: "todo" });
      setNewTitle("");
      setComposerOpen(false);
      void refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Couldn't create card: ${msg}`);
    } finally {
      setCreating(false);
    }
  }, [newTitle, composerProjectId, creating, refresh]);

  const totalVisible = visibleCards.length;

  return (
    <div className="flex flex-col h-full min-h-0 bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <SquareKanban className="w-5 h-5 text-[var(--color-highlight)] shrink-0" />
          <h1 className="text-lg font-semibold tracking-tight truncate">All Boards</h1>
          <span className="text-sm text-[var(--color-text-muted)] truncate">
            · {projects.length} {projects.length === 1 ? "project" : "projects"} · {totalVisible}{" "}
            {totalVisible === 1 ? "task" : "tasks"}
          </span>
          {isLoading && (
            <Loader2 className="w-4 h-4 text-[var(--color-text-muted)] animate-spin" />
          )}
        </div>
        <button
          type="button"
          onClick={openComposer}
          disabled={projects.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--color-highlight)] text-[var(--color-bg)] hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4" />
          New card
        </button>
      </header>

      {/* Project filter chips */}
      {projects.length > 1 && (
        <div className="flex items-center gap-1.5 px-6 py-2.5 border-b border-[var(--color-border)] overflow-x-auto">
          <button
            type="button"
            onClick={() => setProjectFilter(null)}
            aria-pressed={!effectiveFilter}
            className={[
              "shrink-0 px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
              !effectiveFilter
                ? "bg-[var(--color-highlight)] text-[var(--color-bg)]"
                : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
            ].join(" ")}
          >
            All
          </button>
          {projects.map((p) => {
            const active = !effectiveFilter || effectiveFilter.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggleProject(p.id)}
                title={p.name}
                aria-pressed={active}
                className={[
                  "shrink-0 max-w-[12rem] truncate px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
                  effectiveFilter && effectiveFilter.has(p.id)
                    ? "bg-[var(--color-highlight)] text-[var(--color-bg)]"
                    : active
                      ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text)]"
                      : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]/60 hover:text-[var(--color-text)]",
                ].join(" ")}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      )}

      {/* Composer */}
      {composerOpen && (
        <div className="flex items-center gap-2 px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <select
            value={composerProjectId}
            onChange={(e) => setComposerProjectId(e.target.value)}
            aria-label="Project for new card"
            className="shrink-0 px-2.5 py-1.5 rounded-lg text-sm bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)]"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
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
            placeholder="Describe the task… (creates a To Do card in the chosen project)"
            className="flex-1 min-w-0 px-3 py-1.5 rounded-lg text-sm bg-[var(--color-bg)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)]"
          />
          <button
            type="button"
            onClick={() => void submitNewCard()}
            disabled={!newTitle.trim() || !composerProjectId || creating}
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

      {/* Load-failure banner — when a refresh fails but we kept prior data on
          screen, surface the staleness + a retry (the empty-state below only
          covers the no-data case). */}
      {loadError && projects.length > 0 && (
        <div className="flex items-center justify-between gap-3 px-6 py-2 text-sm text-[var(--color-error)] bg-[var(--color-error)]/10 border-b border-[var(--color-error)]/20">
          <span className="truncate">Showing cached boards — {loadError}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 px-2 py-0.5 rounded text-xs font-medium bg-[var(--color-error)]/15 hover:bg-[var(--color-error)]/25 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty / load-failure state — a fetch failure must not masquerade as
          an empty board, so we distinguish the two and offer a retry. */}
      {!isLoading && projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 min-h-[50vh] text-center px-6">
          <SquareKanban className="w-10 h-10 text-[var(--color-text-muted)] mb-3" />
          {loadError ? (
            <>
              <h2 className="text-lg font-semibold mb-1">Couldn't load boards</h2>
              <p className="text-sm text-[var(--color-text-muted)] max-w-sm mb-4">{loadError}</p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[var(--color-highlight)] text-[var(--color-bg)] hover:opacity-90 transition-opacity"
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold mb-1">No boards yet</h2>
              <p className="text-sm text-[var(--color-text-muted)] max-w-sm">
                Add a coding project to see its tasks here.
              </p>
            </>
          )}
        </div>
      ) : (
        /* Columns */
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
              cards={(projects.length ? byColumn : EMPTY_BY_COLUMN)[def.id]}
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
      )}
    </div>
  );
}
