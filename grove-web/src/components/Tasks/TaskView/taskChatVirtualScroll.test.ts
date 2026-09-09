import { describe, expect, it } from "vitest";
import {
  firstVisibleTaskChatRow,
  nextTaskChatFollowState,
  shouldConfirmTaskChatBottom,
  shouldDisengageTaskChatAutoStick,
  shouldFollowTaskChatSend,
  shouldVirtualizeTaskChat,
  taskChatPrependTurnWindowStart,
  taskChatRenderIndex,
  taskChatVirtuosoIndex,
  taskChatWindowStartForLastTurns,
  taskChatWindowStartForRenderIndex,
  taskChatHeightCacheKey,
  taskChatHeightEstimates,
  taskChatLayoutTransitionTarget,
  taskChatShouldDriveBottom,
  taskChatVirtualizationLayoutKey,
} from "./taskChatVirtualScroll";

describe("scrollVirtuosoToBottom", () => {
  it("models follow, detach, and explicit reattachment without ambiguity", () => {
    expect(nextTaskChatFollowState("following", "user-left-bottom")).toBe(
      "detached",
    );
    expect(nextTaskChatFollowState("detached", "request-bottom")).toBe(
      "reattaching",
    );
    expect(nextTaskChatFollowState("following", "request-bottom")).toBe(
      "following",
    );
    expect(
      nextTaskChatFollowState("reattaching", "bottom-confirmed"),
    ).toBe("following");
    expect(taskChatShouldDriveBottom("following")).toBe(true);
    expect(taskChatShouldDriveBottom("reattaching")).toBe(true);
    expect(taskChatShouldDriveBottom("detached")).toBe(false);
  });

  it("switches renderers solely at the configured performance threshold", () => {
    for (const threshold of [0, 1, 10, 50]) {
      expect(shouldVirtualizeTaskChat(threshold, threshold)).toBe(false);
      expect(shouldVirtualizeTaskChat(threshold + 1, threshold)).toBe(true);
    }
  });

  it("anchors windows on complete turns regardless of render item volume", () => {
    const turnStarts = [0, 2, 5, 70, 74, 140];
    expect(taskChatWindowStartForLastTurns(turnStarts, 2)).toBe(74);
    expect(taskChatWindowStartForLastTurns(turnStarts, 20)).toBe(0);
    expect(taskChatPrependTurnWindowStart(turnStarts, 74, 2)).toBe(5);
    expect(taskChatPrependTurnWindowStart(turnStarts, 5, 20)).toBe(0);
  });

  it("expands navigation to the containing complete turn", () => {
    const turnStarts = [0, 2, 5, 70, 74, 140];
    expect(taskChatWindowStartForRenderIndex(turnStarts, 139, 1)).toBe(70);
    expect(taskChatWindowStartForRenderIndex(turnStarts, 72, 0)).toBe(70);
    expect(taskChatWindowStartForRenderIndex(turnStarts, 1, 0)).toBe(0);
  });

  it("maps stable transcript indexes to positive Virtuoso indexes", () => {
    const base = 1_000_000;
    expect(taskChatVirtuosoIndex(137, base)).toBe(1_000_137);
    expect(taskChatRenderIndex(1_000_137, base)).toBe(137);
  });

  it("preserves bottom-following when a genuinely long chat becomes virtual", () => {
    expect(
      taskChatLayoutTransitionTarget("direct", "virtual:72", true, null),
    ).toEqual({ kind: "bottom" });
  });

  it("preserves the exact history anchor when the reader is detached", () => {
    const anchor = { key: "m-37", index: 37, offset: -24 };
    expect(
      taskChatLayoutTransitionTarget("direct", "virtual:72", false, anchor),
    ).toEqual({
      kind: "anchor",
      anchor,
    });
    expect(
      taskChatLayoutTransitionTarget("virtual:72", "virtual:72", true, anchor),
    ).toEqual({
      kind: "none",
    });
  });

  it("does not mistake Virtuoso layout correction for a user scroll", () => {
    expect(
      shouldDisengageTaskChatAutoStick({
        atBottom: false,
        userGestureActive: false,
        programmaticScroll: false,
      }),
    ).toBe(false);
    expect(
      shouldDisengageTaskChatAutoStick({
        atBottom: false,
        userGestureActive: true,
        programmaticScroll: false,
      }),
    ).toBe(true);
    expect(
      shouldDisengageTaskChatAutoStick({
        atBottom: false,
        userGestureActive: true,
        programmaticScroll: true,
      }),
    ).toBe(false);
  });

  it("never reattaches a detached reader from a layout-only bottom event", () => {
    expect(
      shouldConfirmTaskChatBottom({
        state: "detached",
        atBottom: true,
        userMovedTowardBottom: false,
        programmaticScroll: false,
      }),
    ).toBe(false);
    expect(
      shouldConfirmTaskChatBottom({
        state: "detached",
        atBottom: true,
        userMovedTowardBottom: true,
        programmaticScroll: true,
      }),
    ).toBe(false);
  });

  it("reattaches only from an explicit request or a downward user arrival", () => {
    expect(
      shouldConfirmTaskChatBottom({
        state: "reattaching",
        atBottom: true,
        userMovedTowardBottom: false,
        programmaticScroll: true,
      }),
    ).toBe(true);
    expect(
      shouldConfirmTaskChatBottom({
        state: "detached",
        atBottom: true,
        userMovedTowardBottom: true,
        programmaticScroll: false,
      }),
    ).toBe(true);
  });

  it("preserves history reading through queue/layout updates, then resumes at bottom", () => {
    let state = nextTaskChatFollowState("following", "user-left-bottom");
    expect(state).toBe("detached");
    expect(shouldFollowTaskChatSend(true, state === "following")).toBe(false);

    const layoutOnlyBottom = shouldConfirmTaskChatBottom({
      state,
      atBottom: true,
      userMovedTowardBottom: false,
      programmaticScroll: false,
    });
    if (layoutOnlyBottom) {
      state = nextTaskChatFollowState(state, "bottom-confirmed");
    }
    expect(state).toBe("detached");

    const userReachedBottom = shouldConfirmTaskChatBottom({
      state,
      atBottom: true,
      userMovedTowardBottom: true,
      programmaticScroll: false,
    });
    if (userReachedBottom) {
      state = nextTaskChatFollowState(state, "bottom-confirmed");
    }
    expect(state).toBe("following");
    expect(taskChatShouldDriveBottom(state)).toBe(true);
  });

  it("does not move a detached reader when a message is only queued", () => {
    expect(shouldFollowTaskChatSend(false, false)).toBe(true);
    expect(shouldFollowTaskChatSend(true, true)).toBe(true);
    expect(shouldFollowTaskChatSend(true, false)).toBe(false);
  });

  it("keeps the virtual scroller mounted as the cold boundary advances", () => {
    const base = {
      chatId: "chat-a",
      hiddenMessageCount: 0,
      virtualized: true,
    };
    expect(taskChatVirtualizationLayoutKey(base)).toBe(
      "virtual:chat-a:0",
    );
    // The cold-boundary index is deliberately absent from both the input and
    // output. Advancing it appends data and must not create a new React key.
  });

  it("uses the same scoped key for measured and estimated row heights", () => {
    const items = [{ key: "a" }, { key: "b" }, { key: "c" }];
    const scope = "chat-a:0:920";
    const measured = new Map([
      [taskChatHeightCacheKey(scope, "a"), 84],
      [taskChatHeightCacheKey(scope, "c"), 340],
    ]);
    expect(
      taskChatHeightEstimates(
        items,
        (item) => taskChatHeightCacheKey(scope, item.key),
        measured,
        120,
      ),
    ).toEqual([84, 120, 340]);
  });

  it("tracks the first row intersecting the viewport top", () => {
    const rows = [
      { key: "m-8", index: 8, top: -80, bottom: -10 },
      { key: "m-9", index: 9, top: -10, bottom: 60 },
      { key: "m-10", index: 10, top: 60, bottom: 140 },
    ];
    expect(
      firstVisibleTaskChatRow(
        rows.length,
        (index) => rows[index],
        0,
      ),
    ).toEqual({ key: "m-9", index: 9, top: -10, bottom: 60 });
  });
});
