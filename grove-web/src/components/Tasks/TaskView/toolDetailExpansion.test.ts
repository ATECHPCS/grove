import { describe, expect, it } from "vitest";

import { nextExpandedToolDetail } from "./toolDetailExpansion";

describe("nextExpandedToolDetail", () => {
  it("opens the clicked tool when the block has no detail open", () => {
    expect(nextExpandedToolDetail(null, "tool-a")).toBe("tool-a");
  });

  it("replaces the open tool instead of accumulating details", () => {
    expect(nextExpandedToolDetail("tool-a", "tool-b")).toBe("tool-b");
  });

  it("collapses the currently open tool", () => {
    expect(nextExpandedToolDetail("tool-a", "tool-a")).toBeNull();
  });
});
