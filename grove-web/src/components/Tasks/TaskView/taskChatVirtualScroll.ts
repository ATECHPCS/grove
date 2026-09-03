export type TaskChatFollowState =
  | "following"
  | "detached"
  | "reattaching";

export type TaskChatFollowEvent =
  | "user-left-bottom"
  | "request-bottom"
  | "bottom-confirmed";

/**
 * Bottom following is an explicit state machine rather than a collection of
 * independent booleans. In particular, requesting the bottom does not enable
 * streaming follow until the scroller confirms that it actually arrived.
 */
export function nextTaskChatFollowState(
  state: TaskChatFollowState,
  event: TaskChatFollowEvent,
): TaskChatFollowState {
  switch (event) {
    case "user-left-bottom":
      return "detached";
    case "request-bottom":
      return state === "following" ? "following" : "reattaching";
    case "bottom-confirmed":
      return "following";
    default:
      return state;
  }
}

export function taskChatShouldDriveBottom(
  state: TaskChatFollowState,
): boolean {
  return state !== "detached";
}

export function shouldVirtualizeTaskChat(
  turnCount: number,
  directTurnLimit: number,
): boolean {
  return turnCount > directTurnLimit;
}

export function taskChatWindowStartForLastTurns(
  turnRenderIndexes: readonly number[],
  retainedTurnCount: number,
): number {
  if (turnRenderIndexes.length === 0) return 0;
  const turnIndex = Math.max(
    0,
    turnRenderIndexes.length - retainedTurnCount,
  );
  return turnIndex === 0 ? 0 : turnRenderIndexes[turnIndex];
}

export function taskChatWindowStartForRenderIndex(
  turnRenderIndexes: readonly number[],
  renderIndex: number,
  leadingTurnCount: number,
): number {
  if (turnRenderIndexes.length === 0) return 0;
  let containingTurnIndex = 0;
  for (let index = 1; index < turnRenderIndexes.length; index += 1) {
    if (turnRenderIndexes[index] > renderIndex) break;
    containingTurnIndex = index;
  }
  const turnIndex = Math.max(0, containingTurnIndex - leadingTurnCount);
  return turnIndex === 0 ? 0 : turnRenderIndexes[turnIndex];
}

export function taskChatPrependTurnWindowStart(
  turnRenderIndexes: readonly number[],
  currentRenderStart: number,
  batchTurnCount: number,
): number {
  if (currentRenderStart <= 0) return 0;
  const currentTurnIndex = turnRenderIndexes.findIndex(
    (renderIndex) => renderIndex >= currentRenderStart,
  );
  if (currentTurnIndex <= 0) return 0;
  const turnIndex = Math.max(0, currentTurnIndex - batchTurnCount);
  return turnIndex === 0 ? 0 : turnRenderIndexes[turnIndex];
}

export function taskChatVirtuosoIndex(
  renderIndex: number,
  indexBase: number,
): number {
  return indexBase + renderIndex;
}

export function taskChatRenderIndex(
  virtuosoIndex: number,
  indexBase: number,
): number {
  return virtuosoIndex - indexBase;
}

/** Use one exact key for both ResizeObserver writes and estimate reads. */
export function taskChatHeightCacheKey(
  measurementScope: string,
  renderKey: string,
): string {
  return `${measurementScope}:${renderKey}`;
}

export function taskChatVirtualizationLayoutKey({
  chatId,
  hiddenMessageCount,
  virtualized,
}: {
  chatId: string;
  hiddenMessageCount: number;
  virtualized: boolean;
}): string {
  const scope = `${chatId}:${hiddenMessageCount}`;
  return virtualized ? `virtual:${scope}` : `direct:${scope}`;
}

export type TaskChatScrollAnchor = {
  key: string;
  index: number;
  offset: number;
};

export type TaskChatLayoutTransitionTarget =
  | { kind: "none" }
  | { kind: "bottom" }
  | { kind: "anchor"; anchor: TaskChatScrollAnchor };

/**
 * Decide how to restore the viewport when TaskChat swaps between its direct
 * and virtualized renderers. The renderer swap unmounts the old scroller, so
 * its position cannot be left to browser scroll anchoring.
 */
export function taskChatLayoutTransitionTarget(
  previousLayoutKey: string,
  nextLayoutKey: string,
  followingBottom: boolean,
  anchor: TaskChatScrollAnchor | null,
): TaskChatLayoutTransitionTarget {
  if (previousLayoutKey === nextLayoutKey) return { kind: "none" };
  if (followingBottom) return { kind: "bottom" };
  return anchor === null
    ? { kind: "none" }
    : { kind: "anchor", anchor };
}

/**
 * Virtuoso reports `isScrolling` for its own follow-output corrections as
 * well as for user input. Detach bottom-following only when a real gesture was
 * observed; otherwise streaming height changes can masquerade as an upward
 * reader scroll, most visibly when `complete` compacts the live turn.
 */
export function shouldDisengageTaskChatAutoStick({
  atBottom,
  userGestureActive,
  programmaticScroll,
}: {
  atBottom: boolean;
  userGestureActive: boolean;
  programmaticScroll: boolean;
}): boolean {
  return !atBottom && userGestureActive && !programmaticScroll;
}

/**
 * `atBottomStateChange(true)` is a geometry observation, not proof of user
 * intent. Virtuoso can emit it while Footer height or item estimates change.
 * A detached reader may therefore reattach only after an explicit bottom
 * request, or after a real downward user gesture reaches the bottom.
 */
export function shouldConfirmTaskChatBottom({
  state,
  atBottom,
  userMovedTowardBottom,
  programmaticScroll,
}: {
  state: TaskChatFollowState;
  atBottom: boolean;
  userMovedTowardBottom: boolean;
  programmaticScroll: boolean;
}): boolean {
  if (!atBottom) return false;
  if (state !== "detached") return true;
  return userMovedTowardBottom && !programmaticScroll;
}

/**
 * A prompt that starts a new turn should reveal the user's new transcript
 * row. A queued prompt has no transcript row yet and must not steal the
 * viewport from someone reading history; it follows only when they were
 * already following the tail.
 */
export function shouldFollowTaskChatSend(
  queued: boolean,
  alreadyFollowingBottom: boolean,
): boolean {
  return !queued || alreadyFollowingBottom;
}

/** Build per-item Virtuoso estimates from heights measured whenever a row was
 * mounted. Writes and reads must use the same scoped key. */
export function taskChatHeightEstimates<T>(
  items: readonly T[],
  keyForItem: (item: T) => string,
  measuredHeights: ReadonlyMap<string, number>,
  fallbackHeight: number,
): number[] {
  return items.map((item) =>
    measuredHeights.get(keyForItem(item)) ?? fallbackHeight,
  );
}

export type TaskChatVisibleRow = {
  key: string;
  index: number;
  top: number;
  bottom: number;
};

/** Resolve the first row intersecting the viewport's top edge. */
export function firstVisibleTaskChatRow(
  rowCount: number,
  rowAt: (index: number) => TaskChatVisibleRow,
  viewportTop: number,
): TaskChatVisibleRow | null {
  if (rowCount === 0) return null;
  let low = 0;
  let high = rowCount - 1;
  let candidate = high;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = rowAt(middle);
    if (row.bottom >= viewportTop) {
      candidate = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return rowAt(candidate);
}
