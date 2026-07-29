// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useDeferredVirtuosoRangeValue,
  type VirtuosoRange,
} from "./useDeferredVirtuosoRangeValue";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("useDeferredVirtuosoRangeValue", () => {
  let container: HTMLDivElement;
  let root: Root;
  let nextFrameId: number;
  let frames: Map<number, FrameRequestCallback>;
  let onRangeChanged: ((range: VirtuosoRange) => void) | null;

  const flushFrames = () => {
    const queued = Array.from(frames.values());
    frames.clear();
    for (const callback of queued) callback(0);
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    nextFrameId = 1;
    frames = new Map();
    onRangeChanged = null;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
      frames.delete(id);
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("coalesces synchronous range notifications into one deferred update", () => {
    function Harness() {
      const [visibleStart, handleRangeChanged] = useDeferredVirtuosoRangeValue(
        (range) => range.startIndex,
        0,
      );
      onRangeChanged = handleRangeChanged;
      return <span>{visibleStart}</span>;
    }

    act(() => root.render(<Harness />));
    act(() => {
      onRangeChanged?.({ startIndex: 3 });
      onRangeChanged?.({ startIndex: 4 });
      onRangeChanged?.({ startIndex: 5 });
    });

    expect(container.textContent).toBe("0");
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    act(flushFrames);
    expect(container.textContent).toBe("5");
  });

  it("does not re-render while ranges map to the same semantic value", () => {
    let renderCount = 0;
    function Harness() {
      renderCount += 1;
      const [activeGroup, handleRangeChanged] = useDeferredVirtuosoRangeValue(
        (range) => Math.floor(range.startIndex / 10),
        0,
      );
      onRangeChanged = handleRangeChanged;
      return <span>{activeGroup}</span>;
    }

    act(() => root.render(<Harness />));
    act(() => onRangeChanged?.({ startIndex: 3 }));
    act(flushFrames);
    act(() => onRangeChanged?.({ startIndex: 8 }));
    act(flushFrames);

    expect(container.textContent).toBe("0");
    expect(renderCount).toBe(1);

    act(() => onRangeChanged?.({ startIndex: 12 }));
    act(flushFrames);
    expect(container.textContent).toBe("1");
    expect(renderCount).toBe(2);
  });

  it("cancels a pending update when the owner unmounts", () => {
    function Harness() {
      const [, handleRangeChanged] = useDeferredVirtuosoRangeValue(
        (range) => range.startIndex,
        0,
      );
      onRangeChanged = handleRangeChanged;
      return null;
    }

    act(() => root.render(<Harness />));
    act(() => onRangeChanged?.({ startIndex: 8 }));
    act(() => root.unmount());

    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });
});
