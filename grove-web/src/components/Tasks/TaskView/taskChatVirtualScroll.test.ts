import { describe, expect, it, vi } from "vitest";
import {
  firstVisibleTaskChatRow,
  scrollVirtuosoToBottom,
  shouldDisengageTaskChatAutoStick,
  shouldVirtualizeTaskChat,
  taskChatHeightEstimates,
  taskChatLayoutTransitionTarget,
  taskChatVirtualizationLayoutKey,
} from "./taskChatVirtualScroll";

describe("scrollVirtuosoToBottom", () => {
  it("targets the full scroller extent instead of the last data item", () => {
    const scrollTo = vi.fn();

    scrollVirtuosoToBottom({ scrollTo }, "auto");

    expect(scrollTo).toHaveBeenCalledWith({
      top: Number.MAX_SAFE_INTEGER,
      behavior: "auto",
    });
  });

  it("keeps chats within the recent-turn limit out of Virtuoso", () => {
    expect(shouldVirtualizeTaskChat(43, 50)).toBe(false);
    expect(shouldVirtualizeTaskChat(50, 50)).toBe(false);
    expect(shouldVirtualizeTaskChat(51, 50)).toBe(true);
  });

  it("preserves bottom-following across the 50-to-51 renderer swap", () => {
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

  it("reuses measured hot-row heights as Virtuoso estimates", () => {
    const items = [{ key: "a" }, { key: "b" }, { key: "c" }];
    expect(
      taskChatHeightEstimates(
        items,
        (item) => item.key,
        new Map([["a", 84], ["c", 340]]),
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
