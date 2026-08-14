import type { VirtuosoHandle } from "react-virtuoso";

type BottomScrollableVirtuoso = Pick<VirtuosoHandle, "scrollTo">;

export function shouldVirtualizeTaskChat(
  turnCount: number,
  directTurnLimit: number,
): boolean {
  return turnCount > directTurnLimit;
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

/** Build per-item Virtuoso estimates from heights measured while rows were in
 * TaskChat's fully mounted hot zone. */
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

/**
 * Scroll to the complete Virtuoso extent, including its Footer. Aligning the
 * last data item is insufficient when the Footer owns bottom UI and spacing.
 */
export function scrollVirtuosoToBottom(
  handle: BottomScrollableVirtuoso,
  behavior: "auto" | "smooth",
): void {
  handle.scrollTo({
    top: Number.MAX_SAFE_INTEGER,
    behavior,
  });
}
