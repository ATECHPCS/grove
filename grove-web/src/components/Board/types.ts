// Board (Kanban) mode — shared types.
//
// The board renders Grove tasks as cards across four columns, mirroring
// Dorothy's model (TODO → PLANNED → IN WORK → COMPLETED) in Grove's dark skin.
// See docs/board-nanobot-plan.md.

import type { Task } from "../../data/types";

/** Persisted board column ids (mirror backend `BOARD_COLUMNS`). */
export type ColumnId = "todo" | "planned" | "ongoing" | "done";

/**
 * Live agent state for a task, folded down from Radio `chat_status` /
 * `task_status` events. `permission` = the agent is waiting on the user
 * (Dorothy's amber "waiting"); `busy` = actively working (green pulse).
 */
export type LiveStatus =
  | "idle"
  | "busy"
  | "permission"
  | "disconnected";

/** A single card on the board: a task plus its derived display column. */
export interface BoardCardData {
  task: Task;
  projectId: string;
  projectName: string;
  /** Live agent state, if the task has an active session. */
  live?: LiveStatus;
  /** The column the card is displayed in (live-status-aware). */
  column: ColumnId;
}

/** Column display metadata. Accents follow the plan: zinc/blue/amber/green. */
export interface ColumnDef {
  id: ColumnId;
  label: string;
  /** Whether cards can be dragged *into* this column by the user. IN WORK and
   *  COMPLETED are reached by the agent lifecycle, never a manual drop. */
  droppable: boolean;
  /** Tailwind accent color name used for the header rule + count pill. */
  accent: "zinc" | "blue" | "amber" | "emerald";
}

export const BOARD_COLUMNS: ColumnDef[] = [
  { id: "todo", label: "To Do", droppable: true, accent: "zinc" },
  { id: "planned", label: "Planned", droppable: true, accent: "blue" },
  { id: "ongoing", label: "In Work", droppable: false, accent: "amber" },
  { id: "done", label: "Completed", droppable: false, accent: "emerald" },
];

const VALID: ColumnId[] = ["todo", "planned", "ongoing", "done"];

/**
 * Resolve the column a card is displayed in. A live busy/permission session
 * always wins (the card shows in IN WORK regardless of its persisted stage —
 * dispatch leaves the card filed in todo/planned while the agent runs). Absent
 * a live session we fall back to the persisted column.
 */
export function derivedColumn(task: Task, live?: LiveStatus): ColumnId {
  if (live === "busy" || live === "permission") return "ongoing";
  const persisted = (task.boardColumn ?? "todo") as ColumnId;
  return VALID.includes(persisted) ? persisted : "todo";
}
