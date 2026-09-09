export interface SessionListItem {
  id: string;
}

/**
 * Reflect local activity immediately instead of waiting for the backend's
 * touch -> radio event -> full-list refetch round trip.
 */
export function promoteSession<T extends SessionListItem>(
  sessions: readonly T[],
  sessionId: string,
): T[] {
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index <= 0) return [...sessions];
  return [sessions[index], ...sessions.slice(0, index), ...sessions.slice(index + 1)];
}

/**
 * A recency refresh may reorder sessions, but it must not temporarily evict
 * the active session. Selection is an explicit user/lifecycle decision, not a
 * side effect of list ordering.
 */
export function preserveActiveSessionInRefresh<T extends SessionListItem>(
  fresh: readonly T[],
  activeId: string | null,
  activeSession: T | undefined,
  activeWasArchived: boolean,
): T[] {
  if (
    !activeId ||
    !activeSession ||
    activeWasArchived ||
    fresh.some((session) => session.id === activeId)
  ) {
    return [...fresh];
  }
  return [activeSession, ...fresh];
}

/** Runtime state is newer than a switch-time UI snapshot. */
export function resolveRestoredBusy(
  runtimeBusy: boolean | undefined,
  cachedBusy: boolean | undefined,
): boolean {
  return runtimeBusy ?? cachedBusy ?? false;
}

/** Live transcript state is newer than a switch-time UI snapshot. */
export function resolveRestoredMessages<T>(
  runtimeMessages: T[] | undefined,
  cachedMessages: T[] | undefined,
): T[] {
  return runtimeMessages ?? cachedMessages ?? [];
}
