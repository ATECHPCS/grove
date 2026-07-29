import { useCallback, useEffect, useRef, useState } from "react";

export type VirtuosoRange = {
  startIndex: number;
};

/**
 * Coalesce Virtuoso range notifications outside its layout-effect commit.
 *
 * Virtuoso can synchronously replay `rangeChanged` while subscribing and
 * measuring. Updating the parent in that callback can make the list measure
 * again before the current commit has settled, eventually hitting React's
 * maximum update depth. Deferring to the next frame breaks that re-entrant
 * commit chain and naturally keeps only the newest semantic range value.
 */
export function useDeferredVirtuosoRangeValue<T>(
  getValue: (range: VirtuosoRange) => T,
  initialValue: T,
) {
  const [value, setValue] = useState(initialValue);
  const pendingValueRef = useRef(initialValue);
  const frameRef = useRef<number | null>(null);

  const handleRangeChanged = useCallback((range: VirtuosoRange) => {
    pendingValueRef.current = getValue(range);
    if (frameRef.current !== null) return;

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const nextValue = pendingValueRef.current;
      setValue((previous) =>
        Object.is(previous, nextValue) ? previous : nextValue,
      );
    });
  }, [getValue]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  return [value, handleRangeChanged] as const;
}
