// Board data hook — loads the current project's tasks and folds live Radio
// events into per-task agent status, so cards move between columns without a
// full refetch.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getProject } from "../../api";
import { convertTaskResponse } from "../../utils/taskConvert";
import { useRadioEvents } from "../../hooks";
import { useProject } from "../../context";
import type { Task } from "../../data/types";
import type { NodeStatus } from "../../api/walkieTalkie";
import {
  BOARD_COLUMNS,
  derivedColumn,
  type BoardCardData,
  type ColumnId,
  type LiveStatus,
} from "./types";

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

export interface UseBoardTasks {
  cards: BoardCardData[];
  /** Cards grouped by their (derived) column, in board order. */
  byColumn: Record<ColumnId, BoardCardData[]>;
  isLoading: boolean;
  projectId: string | null;
  projectName: string | null;
  isStudio: boolean;
  refresh: () => void;
  /** Optimistically set a task's persisted column before the server confirms. */
  applyStage: (taskId: string, column: ColumnId) => void;
  /** Optimistically set a task's live status (e.g. right after starting one). */
  applyLive: (taskId: string, live: LiveStatus) => void;
}

const EMPTY_BY_COLUMN: Record<ColumnId, BoardCardData[]> = {
  todo: [],
  planned: [],
  ongoing: [],
  done: [],
};

export function useBoardTasks(): UseBoardTasks {
  const { selectedProject } = useProject();
  const projectId = selectedProject?.id ?? null;
  const projectName = selectedProject?.name ?? null;
  const isStudio = selectedProject?.projectType === "studio";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [liveById, setLiveById] = useState<Record<string, LiveStatus>>({});
  const [isLoading, setIsLoading] = useState(true);

  // Guard against out-of-order fetches when the project switches mid-flight.
  const reqSeq = useRef(0);

  const fetchTasks = useCallback(async () => {
    if (!projectId) {
      setTasks([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const seq = ++reqSeq.current;
    try {
      const full = await getProject(projectId);
      if (seq !== reqSeq.current) return; // superseded
      const active = full.tasks
        .filter((t) => t.status !== "archived")
        .map(convertTaskResponse);
      setTasks(active);
    } catch (err) {
      if (seq === reqSeq.current) {
        console.error("[Board] fetch failed:", err);
        setTasks([]);
      }
    } finally {
      if (seq === reqSeq.current) setIsLoading(false);
    }
  }, [projectId]);

  // Deferred to a microtask (not called synchronously in the effect body) so
  // the state resets don't trigger the cascading-render lint. Live status is
  // cleared here because it belongs to the previously selected project.
  useEffect(() => {
    Promise.resolve().then(() => {
      setLiveById({});
      void fetchTasks();
    });
  }, [fetchTasks]);

  // Stable callback bag for the shared Radio socket. We read projectId through
  // a ref so the socket subscription never needs to re-bind on project switch.
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  const setLive = useCallback((taskId: string, live: LiveStatus | undefined) => {
    setLiveById((prev) => {
      if (live === undefined) {
        if (!(taskId in prev)) return prev;
        const next = { ...prev };
        delete next[taskId];
        return next;
      }
      if (prev[taskId] === live) return prev;
      return { ...prev, [taskId]: live };
    });
  }, []);

  useRadioEvents({
    onTaskStatus: (pid, tid, status) => {
      if (pid !== projectIdRef.current) return;
      setLive(tid, status as LiveStatus);
    },
    onChatStatus: (pid, tid, _cid, status) => {
      if (pid !== projectIdRef.current) return;
      setLive(tid, fromNodeStatus(status));
    },
    onTaskStageChanged: (pid, tid, column, order) => {
      if (pid !== projectIdRef.current) return;
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === tid);
        if (idx === -1) {
          // A card we don't have yet (e.g. freshly dispatched) — pull it in.
          void fetchTasks();
          return prev;
        }
        const next = [...prev];
        next[idx] = { ...next[idx], boardColumn: column, boardOrder: order };
        return next;
      });
    },
    // A new chat or task-group change can mean a dispatched card appeared.
    onChatListChanged: (pid) => {
      if (pid === projectIdRef.current) void fetchTasks();
    },
    onGroupChanged: () => {
      void fetchTasks();
    },
  });

  const applyStage = useCallback((taskId: string, column: ColumnId) => {
    setTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === taskId);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], boardColumn: column };
      return next;
    });
  }, []);

  const applyLive = useCallback(
    (taskId: string, live: LiveStatus) => setLive(taskId, live),
    [setLive],
  );

  const cards = useMemo<BoardCardData[]>(() => {
    return tasks.map((task) => {
      const live = liveById[task.id];
      return {
        task,
        projectId: projectId ?? "",
        projectName: projectName ?? "",
        live,
        column: derivedColumn(task, live),
      };
    });
  }, [tasks, liveById, projectId, projectName]);

  const byColumn = useMemo<Record<ColumnId, BoardCardData[]>>(() => {
    const groups: Record<ColumnId, BoardCardData[]> = {
      todo: [],
      planned: [],
      ongoing: [],
      done: [],
    };
    for (const card of cards) groups[card.column].push(card);
    for (const col of BOARD_COLUMNS) {
      groups[col.id].sort(
        (a, b) => (a.task.boardOrder ?? 0) - (b.task.boardOrder ?? 0),
      );
    }
    return groups;
  }, [cards]);

  return {
    cards,
    byColumn: projectId ? byColumn : EMPTY_BY_COLUMN,
    isLoading,
    projectId,
    projectName,
    isStudio: !!isStudio,
    refresh: fetchTasks,
    applyStage,
    applyLive,
  };
}
