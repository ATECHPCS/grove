import { describe, expect, it } from "vitest";
import {
  bottomDistance,
  buildBottomOriginLayout,
  scrollTopForBottomDistance,
  visibleBottomOriginIndexes,
} from "./bottomOriginLayout";

describe("bottom-origin layout", () => {
  it("places newest item at the exact bottom", () => {
    const layout = buildBottomOriginLayout([
      { key: "new", height: 40 },
      { key: "old", height: 60 },
    ]);
    expect(layout.totalHeight).toBe(100);
    expect(layout.positions).toEqual([
      { key: "new", height: 40, index: 0, top: 60, bottom: 100 },
      { key: "old", height: 60, index: 1, top: 0, bottom: 60 },
    ]);
  });

  it("keeps existing item coordinates when a new item is inserted at zero", () => {
    const before = buildBottomOriginLayout([
      { key: "a", height: 40 },
      { key: "b", height: 60 },
    ]);
    const after = buildBottomOriginLayout([
      { key: "new", height: 25 },
      { key: "a", height: 40 },
      { key: "b", height: 60 },
    ]);
    expect(after.positions.find((item) => item.key === "a")?.top).toBe(
      before.positions.find((item) => item.key === "a")?.top,
    );
    expect(after.positions.find((item) => item.key === "b")?.top).toBe(
      before.positions.find((item) => item.key === "b")?.top,
    );
  });

  it("lets the newest turn grow without moving older turns", () => {
    const before = buildBottomOriginLayout([
      { key: "new", height: 40 },
      { key: "old", height: 60 },
    ]);
    const after = buildBottomOriginLayout([
      { key: "new", height: 400 },
      { key: "old", height: 60 },
    ]);
    expect(after.positions.find((item) => item.key === "old")?.top).toBe(
      before.positions.find((item) => item.key === "old")?.top,
    );
  });

  it("keeps every newer item's distance from the bottom when an older item changes", () => {
    const before = buildBottomOriginLayout([
      { key: "new", height: 40 },
      { key: "middle", height: 60 },
      { key: "old", height: 80 },
    ]);
    const after = buildBottomOriginLayout([
      { key: "new", height: 40 },
      { key: "middle", height: 60 },
      { key: "old", height: 800 },
    ]);
    for (const key of ["new", "middle"]) {
      const beforeItem = before.positions.find((item) => item.key === key)!;
      const afterItem = after.positions.find((item) => item.key === key)!;
      expect(after.totalHeight - afterItem.top).toBe(
        before.totalHeight - beforeItem.top,
      );
    }
  });

  it("round-trips a reader's distance from the bottom", () => {
    const distance = bottomDistance(4_000, 2_700, 800);
    expect(distance).toBe(500);
    expect(scrollTopForBottomDistance(5_200, 800, distance)).toBe(3_900);
  });

  it("selects only positions intersecting the overscanned viewport", () => {
    const { positions } = buildBottomOriginLayout([
      { key: "new", height: 100 },
      { key: "middle", height: 100 },
      { key: "old", height: 100 },
    ]);
    expect(visibleBottomOriginIndexes(positions, 180, 240, 10)).toEqual([0, 1]);
  });
});
