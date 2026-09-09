export type BottomOriginItem = {
  key: string;
  height: number;
};

export type BottomOriginPosition = BottomOriginItem & {
  index: number;
  top: number;
  bottom: number;
};

/**
 * Lay out newest-first items in normal visual order (oldest at the top,
 * newest at the bottom). The bottom edge of item 0 is always totalHeight.
 */
export function buildBottomOriginLayout(
  items: readonly BottomOriginItem[],
): { totalHeight: number; positions: BottomOriginPosition[] } {
  const totalHeight = items.reduce((sum, item) => sum + item.height, 0);
  let offsetFromBottom = 0;
  const positions = items.map((item, index) => {
    const bottom = totalHeight - offsetFromBottom;
    const top = bottom - item.height;
    offsetFromBottom += item.height;
    return { ...item, index, top, bottom };
  });
  return { totalHeight, positions };
}

export function bottomDistance(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function scrollTopForBottomDistance(
  scrollHeight: number,
  clientHeight: number,
  distance: number,
): number {
  return Math.max(0, scrollHeight - clientHeight - distance);
}

export function visibleBottomOriginIndexes(
  positions: readonly BottomOriginPosition[],
  viewportTop: number,
  viewportBottom: number,
  overscan: number,
): number[] {
  const min = viewportTop - overscan;
  const max = viewportBottom + overscan;
  return positions
    .filter((position) => position.bottom >= min && position.top <= max)
    .map((position) => position.index);
}
