import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_RENDER_WINDOW_LIMIT,
  normalizeChatRenderWindowSettings,
  pruneChatViewMessages,
} from "./chatRenderWindow";

describe("normalizeChatRenderWindowSettings", () => {
  it("applies the default window when the limit is unset (tranche-2)", () => {
    const s = normalizeChatRenderWindowSettings(undefined, undefined);
    expect(s.limit).toBe(DEFAULT_CHAT_RENDER_WINDOW_LIMIT);
    expect(s.trigger).toBe(DEFAULT_CHAT_RENDER_WINDOW_LIMIT + 500);
    expect(s.trigger).toBeGreaterThan(s.limit); // pruning is reachable
  });

  it("treats an explicit 0 as disabled / unbounded (opt-out preserved)", () => {
    const s = normalizeChatRenderWindowSettings(0, undefined);
    expect(s.limit).toBe(0);
    expect(s.trigger).toBe(1500);
  });

  it("respects an explicit limit and derives a trigger above it", () => {
    expect(normalizeChatRenderWindowSettings(300, undefined)).toEqual({
      limit: 300,
      trigger: 800,
    });
  });

  it("keeps an explicit trigger when it exceeds the limit", () => {
    expect(normalizeChatRenderWindowSettings(300, 2000)).toEqual({
      limit: 300,
      trigger: 2000,
    });
  });

  it("floors fractional config and clamps negatives", () => {
    expect(normalizeChatRenderWindowSettings(300.9, 800.9)).toEqual({
      limit: 300,
      trigger: 800,
    });
    // negative limit clamps to 0 → disabled branch
    expect(normalizeChatRenderWindowSettings(-5, undefined).limit).toBe(0);
  });
});

describe("pruneChatViewMessages", () => {
  const s = normalizeChatRenderWindowSettings(undefined, undefined); // 600 / 1100

  it("does nothing below the trigger", () => {
    const msgs = Array.from({ length: s.trigger - 1 }, (_, i) => i);
    const out = pruneChatViewMessages(msgs, 0, s);
    expect(out.pruned).toBe(false);
    expect(out.messages).toHaveLength(s.trigger - 1);
    expect(out.hiddenMessageCount).toBe(0);
  });

  it("keeps exactly `limit` most-recent items once the trigger is crossed", () => {
    const total = s.trigger + 50;
    const msgs = Array.from({ length: total }, (_, i) => i);
    const out = pruneChatViewMessages(msgs, 0, s);
    expect(out.pruned).toBe(true);
    expect(out.messages).toHaveLength(s.limit);
    // the retained slice is the tail (newest), not the head
    expect(out.messages[0]).toBe(total - s.limit);
    expect(out.messages.at(-1)).toBe(total - 1);
    expect(out.hiddenMessageCount).toBe(total - s.limit);
  });

  it("accumulates hidden count across successive prunes", () => {
    const first = pruneChatViewMessages(
      Array.from({ length: s.trigger + 10 }, (_, i) => i),
      0,
      s,
    );
    const second = pruneChatViewMessages(
      Array.from({ length: s.trigger + 10 }, (_, i) => i),
      first.hiddenMessageCount,
      s,
    );
    expect(second.hiddenMessageCount).toBeGreaterThan(first.hiddenMessageCount);
  });

  it("never prunes when disabled (explicit 0)", () => {
    const disabled = normalizeChatRenderWindowSettings(0, undefined);
    const msgs = Array.from({ length: 5000 }, (_, i) => i);
    expect(pruneChatViewMessages(msgs, 0, disabled).pruned).toBe(false);
  });
});
