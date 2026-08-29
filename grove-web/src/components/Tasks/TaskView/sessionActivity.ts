export interface SessionActivity {
  running: boolean;
  unread: boolean;
}

export type SessionActivityMap = Record<string, SessionActivity>;

/**
 * Track transient session-list status for the lifetime of TaskChat.
 * A completion becomes unread only when it transitions from running while
 * another session is active. Nothing here is persisted across remounts.
 */
export function updateSessionRunning(
  previous: SessionActivityMap,
  chatId: string,
  running: boolean,
  activeChatId: string | null,
): SessionActivityMap {
  const current = previous[chatId];
  if (!current && !running) return previous;

  const unread = running
    ? (current?.unread ?? false)
    : (current?.unread ?? false) || (!!current?.running && chatId !== activeChatId);

  if (current?.running === running && current.unread === unread) return previous;

  return {
    ...previous,
    [chatId]: { running, unread },
  };
}

export interface RunningChatSnapshot {
  chatId: string;
  /** "idle" | "busy" | "permission_required" */
  status: string;
}

/**
 * Seed running-indicators from a mount-time snapshot of live sessions, so the
 * session rail shows busy siblings immediately after a remount (mode switch)
 * instead of appearing idle until each sibling's WS connects. Only siblings are
 * seeded — the active chat is driven by its own WS — and a chat already tracked
 * is left untouched, so the live stream stays the source of truth.
 */
export function seedRunningFromSnapshot(
  previous: SessionActivityMap,
  snapshot: RunningChatSnapshot[],
  activeChatId: string | null,
): SessionActivityMap {
  let next = previous;
  for (const { chatId, status } of snapshot) {
    if (chatId === activeChatId) continue;
    if (chatId in next) continue;
    const running = status === "busy" || status === "permission_required";
    if (!running) continue;
    next = updateSessionRunning(next, chatId, true, activeChatId);
  }
  return next;
}

export function markSessionRead(
  previous: SessionActivityMap,
  chatId: string,
): SessionActivityMap {
  const current = previous[chatId];
  if (!current?.unread) return previous;

  return {
    ...previous,
    [chatId]: { ...current, unread: false },
  };
}

export function removeSessionActivity(
  previous: SessionActivityMap,
  chatId: string,
): SessionActivityMap {
  if (!(chatId in previous)) return previous;
  const next = { ...previous };
  delete next[chatId];
  return next;
}
