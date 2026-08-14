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
