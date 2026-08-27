import { useState } from "react";

/**
 * Cold-load task deep-link: `<grove-web>/#project=<pid>&task=<tid>`.
 *
 * The board otherwise only selects a task through in-app navigation (palette,
 * board click, notification handoff) — there was no way to link *into* a
 * specific card from outside the app. nanobot's `file_bug` dispatch builds
 * exactly this URL from the returned task id so the origin record (an Odoo
 * ticket, a Chatwoot conversation, a voice log) can carry a link back to the
 * Grove card it became (F1).
 *
 * On mount this parks the ids in sessionStorage (so a mid-auth reload still
 * finds them) and strips the two keys from the hash — mirroring
 * `useAddLibraryHashHandler` — then hands them back to App.tsx exactly once.
 * App routes via its existing cross-project open path (`handleOpenGlobalTask`),
 * which selects the card's project first, so the link works even when the
 * target card belongs to a project that isn't currently selected.
 */

const PENDING_KEY = "grove.pendingTaskDeepLink";
/** Discard a parked deep-link older than this so a restored session doesn't
 *  yank the user into a stale card they don't remember linking to. */
const PENDING_TTL_MS = 60 * 60 * 1000;

export interface TaskDeepLink {
  projectId: string;
  taskId: string;
}

function clearHash(): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.delete("project");
  params.delete("task");
  const remaining = params.toString();
  window.history.replaceState(
    {},
    "",
    remaining
      ? `${window.location.pathname}${window.location.search}#${remaining}`
      : `${window.location.pathname}${window.location.search}`,
  );
}

function pickPending(): TaskDeepLink | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (hash.includes("task=")) {
    const params = new URLSearchParams(hash.slice(1));
    const taskId = params.get("task");
    const projectId = params.get("project");
    if (taskId && projectId) {
      try {
        window.sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({ projectId, taskId, ts: Date.now() }),
        );
      } catch {
        /* sessionStorage unavailable — fall through to return the live values */
      }
      clearHash();
      return { projectId, taskId };
    }
  }
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      projectId?: string;
      taskId?: string;
      ts?: number;
    };
    const ts = parsed.ts ?? 0;
    if (!parsed.projectId || !parsed.taskId || (ts > 0 && Date.now() - ts > PENDING_TTL_MS)) {
      dropPending();
      return null;
    }
    return { projectId: parsed.projectId, taskId: parsed.taskId };
  } catch {
    return null;
  }
}

export function dropPending(): void {
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Returns a pending task deep-link once (parked from the URL hash on mount),
 * or null. The caller consumes it — routing into the task — and then calls
 * `dropPending()` so a later remount doesn't re-navigate.
 */
export function useTaskDeepLink(): TaskDeepLink | null {
  // Lazy initializer: read (and strip) the hash exactly once at mount. Its side
  // effects — parking to sessionStorage, clearing the two hash keys — are all
  // idempotent, so a StrictMode double-invoke in dev is harmless.
  const [link] = useState<TaskDeepLink | null>(() => pickPending());
  return link;
}
