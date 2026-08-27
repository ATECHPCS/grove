// Global Board data hook — the cross-project sibling of `useBoardTasks`.
//
// Where the per-project board hook loads a single project's tasks and filters
// Radio events to that project, this one enumerates *every* project (the Blitz
// pattern: listProjects → getProject per project) and folds live agent status
// across all of them. Live status is keyed by `${projectId}:${taskId}` so two
// projects that happen to share a task id never collide.
//
// Studio projects are skipped: the board dispatches coding agents, which Studio
// projects don't run (mirrors BoardPage's per-project Studio guard).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listProjects, getProject } from "../../api";
import { convertTaskResponse } from "../../utils/taskConvert";
import { useRadioEvents } from "../../hooks";
import type { Task } from "../../data/types";
import type { NodeStatus } from "../../api/walkieTalkie";
import { derivedColumn, type BoardCardData, type ColumnId, type LiveStatus } from "../Board/types";

/** A project as far as the board cares: an id + a display name. */
export interface BoardProject {
  id: string;
  name: string;
}

/** One project's tasks, tagged so cards can carry their origin. */
interface ProjectTasks {
  projectId: string;
  projectName: string;
  tasks: Task[];
}

/** Composite key for the live-status map — task ids are only project-unique. */
function liveKey(projectId: string, taskId: string): string {
  return `${projectId}:${taskId}`;
}

/**
 * Overlay fresh data while preserving the board columns we already hold for
 * tasks that exist in both sets. Used when a stage change (optimistic drag or
 * an authoritative Radio patch) landed while a full fetch was in flight: that
 * fetch's snapshot predates the change, so blindly replacing state would
 * revert the column. We still adopt every other field, plus new/removed tasks.
 */
function mergeKeepingLocalStages(
  prev: ProjectTasks[],
  fetched: ProjectTasks[],
): ProjectTasks[] {
  const prevByKey = new Map<string, Task>();
  for (const pt of prev) {
    for (const t of pt.tasks) prevByKey.set(liveKey(pt.projectId, t.id), t);
  }
  return fetched.map((pt) => ({
    ...pt,
    tasks: pt.tasks.map((t) => {
      const local = prevByKey.get(liveKey(pt.projectId, t.id));
      if (!local) return t;
      return { ...t, boardColumn: local.boardColumn, boardOrder: local.boardOrder };
    }),
  }));
}

/** Fold a chat `NodeStatus` down to the board's coarser `LiveStatus`. */
function fromNodeStatus(status: NodeStatus): LiveStatus | undefined {
  switch (status) {
    case "permission_required":
      return "permission";
    case "busy":
    case "connecting":
      return "busy";
    case "idle":
      return "idle";
    case "disconnected":
      return "disconnected";
    default:
      return undefined;
  }
}

export interface UseGlobalBoardTasks {
  /** Every non-archived task across all repo projects, as board cards. */
  cards: BoardCardData[];
  /** Distinct projects contributing cards (for filter chips + the composer). */
  projects: BoardProject[];
  isLoading: boolean;
  /** Set when the project list itself failed to load (distinct from "empty"). */
  error: string | null;
  refresh: () => void;
  /** Optimistically set a task's persisted column before the server confirms. */
  applyStage: (projectId: string, taskId: string, column: ColumnId) => void;
  /** Optimistically set a task's live status (e.g. right after starting one). */
  applyLive: (projectId: string, taskId: string, live: LiveStatus) => void;
}

export function useGlobalBoardTasks(): UseGlobalBoardTasks {
  const [byProject, setByProject] = useState<ProjectTasks[]>([]);
  const [liveById, setLiveById] = useState<Record<string, LiveStatus>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guard against out-of-order full refetches.
  const reqSeq = useRef(0);
  // Bumped on every local stage change (optimistic drag or Radio patch). A
  // fetch compares this across its await so it can detect a stage mutation
  // that raced it and avoid clobbering the newer value.
  const stageGen = useRef(0);
  // Mirror of `byProject` so patchStage can test task existence synchronously
  // (a state-updater's body is not guaranteed to have run when we branch on it).
  const byProjectRef = useRef<ProjectTasks[]>(byProject);
  useEffect(() => {
    byProjectRef.current = byProject;
  }, [byProject]);

  const fetchAll = useCallback(async () => {
    const seq = ++reqSeq.current;
    const genAtStart = stageGen.current;
    setIsLoading(true);
    try {
      let projectsList: Awaited<ReturnType<typeof listProjects>>["projects"];
      try {
        projectsList = (await listProjects()).projects;
      } catch (err) {
        if (seq === reqSeq.current) {
          console.error("[GlobalBoard] listProjects failed:", err);
          setError(err instanceof Error ? err.message : "Failed to load projects");
          // Keep whatever we already have on screen rather than blanking it.
        }
        return;
      }
      if (seq !== reqSeq.current) return; // superseded

      const results = await Promise.all(
        projectsList.map(async (p): Promise<ProjectTasks | null> => {
          let full: Awaited<ReturnType<typeof getProject>> | null = null;
          try {
            full = await getProject(p.id);
          } catch {
            return null;
          }
          // Studio projects don't dispatch agents — omit them from the board.
          if (full.project_type === "studio") return null;
          const tasks = full.tasks
            .filter((t) => t.status !== "archived")
            .map(convertTaskResponse);
          return { projectId: full.id, projectName: full.name, tasks };
        }),
      );
      if (seq !== reqSeq.current) return; // superseded mid-flight
      setError(null);
      const fetched = results.filter((r): r is ProjectTasks => r !== null);
      // A stage change that landed mid-flight makes this snapshot stale for
      // board columns — merge to keep the newer local columns instead of
      // reverting them. `reqSeq` only orders fetch-vs-fetch, not this case.
      if (stageGen.current !== genAtStart) {
        setByProject((prev) => mergeKeepingLocalStages(prev, fetched));
      } else {
        setByProject(fetched);
      }
    } finally {
      // Always clear the spinner for the request that's still current, even on
      // an unexpected throw during result processing.
      if (seq === reqSeq.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.resolve().then(fetchAll);
  }, [fetchAll]);

  const setLive = useCallback(
    (projectId: string, taskId: string, live: LiveStatus | undefined) => {
      const key = liveKey(projectId, taskId);
      setLiveById((prev) => {
        if (live === undefined) {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        }
        if (prev[key] === live) return prev;
        return { ...prev, [key]: live };
      });
    },
    [],
  );

  // Patch a single task's persisted stage in place. `refetchIfMissing` pulls a
  // full refresh when the task isn't on the board yet (e.g. a card freshly
  // dispatched in another project via a Radio event); optimistic drag updates
  // pass it false because they act on a card we can already see.
  const patchStage = useCallback(
    (
      projectId: string,
      taskId: string,
      column: ColumnId,
      order: number | undefined,
      refetchIfMissing: boolean,
    ) => {
      const exists = byProjectRef.current.some(
        (pt) => pt.projectId === projectId && pt.tasks.some((t) => t.id === taskId),
      );
      if (!exists) {
        if (refetchIfMissing) void fetchAll();
        return;
      }
      // Mark that local board state now leads any in-flight fetch's snapshot.
      stageGen.current += 1;
      setByProject((prev) =>
        prev.map((pt) => {
          if (pt.projectId !== projectId) return pt;
          const idx = pt.tasks.findIndex((t) => t.id === taskId);
          if (idx === -1) return pt;
          const tasks = [...pt.tasks];
          tasks[idx] = {
            ...tasks[idx],
            boardColumn: column,
            ...(order !== undefined ? { boardOrder: order } : {}),
          };
          return { ...pt, tasks };
        }),
      );
    },
    [fetchAll],
  );

  useRadioEvents({
    onTaskStatus: (pid, tid, status) => setLive(pid, tid, status as LiveStatus),
    onChatStatus: (pid, tid, _cid, status) => setLive(pid, tid, fromNodeStatus(status)),
    onTaskStageChanged: (pid, tid, column, order) =>
      patchStage(pid, tid, column as ColumnId, order, true),
    // A new chat or task-group change can mean a dispatched card appeared.
    onChatListChanged: () => void fetchAll(),
    onGroupChanged: () => void fetchAll(),
  });

  const applyStage = useCallback(
    (projectId: string, taskId: string, column: ColumnId) =>
      patchStage(projectId, taskId, column, undefined, false),
    [patchStage],
  );

  const applyLive = useCallback(
    (projectId: string, taskId: string, live: LiveStatus) => setLive(projectId, taskId, live),
    [setLive],
  );

  const cards = useMemo<BoardCardData[]>(
    () =>
      byProject.flatMap((pt) =>
        pt.tasks.map((task) => {
          const live = liveById[liveKey(pt.projectId, task.id)];
          return {
            task,
            projectId: pt.projectId,
            projectName: pt.projectName,
            live,
            column: derivedColumn(task, live),
          };
        }),
      ),
    [byProject, liveById],
  );

  const projects = useMemo<BoardProject[]>(
    () => byProject.map((pt) => ({ id: pt.projectId, name: pt.projectName })),
    [byProject],
  );

  return { cards, projects, isLoading, error, refresh: fetchAll, applyStage, applyLive };
}
