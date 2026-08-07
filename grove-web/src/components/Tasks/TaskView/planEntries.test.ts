import { describe, expect, it } from "vitest";
import {
  normalizePlanEntries,
  shouldOpenPlan,
  sortPlanEntries,
} from "./planEntries";

describe("ACP plan entries", () => {
  it("normalizes legacy inprogress and keeps missing priority compatible", () => {
    expect(
      normalizePlanEntries([
        { content: "Legacy step", status: "inprogress" },
      ]),
    ).toEqual([
      { content: "Legacy step", status: "in_progress", priority: undefined },
    ]);
  });

  it("sorts by priority and preserves Agent order within each priority", () => {
    const entries = normalizePlanEntries([
      { content: "Low one", priority: "low", status: "pending" },
      { content: "High one", priority: "high", status: "completed" },
      { content: "High two", priority: "high", status: "in_progress" },
      { content: "Medium", priority: "medium", status: "pending" },
      { content: "Legacy", status: "pending" },
    ]);

    expect(sortPlanEntries(entries).map((entry) => entry.content)).toEqual([
      "High one",
      "High two",
      "Medium",
      "Low one",
      "Legacy",
    ]);
  });

  it("opens only non-empty plans that still have unfinished work", () => {
    expect(shouldOpenPlan([])).toBe(false);
    expect(
      shouldOpenPlan([
        { content: "Done", priority: "high", status: "completed" },
      ]),
    ).toBe(false);
    expect(
      shouldOpenPlan([
        { content: "Working", priority: "high", status: "in_progress" },
      ]),
    ).toBe(true);
  });

});
