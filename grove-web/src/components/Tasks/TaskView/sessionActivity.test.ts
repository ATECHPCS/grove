import { describe, expect, it } from "vitest";
import {
  markSessionRead,
  removeSessionActivity,
  seedRunningFromSnapshot,
  updateSessionRunning,
  type SessionActivityMap,
} from "./sessionActivity";

describe("session activity", () => {
  it("marks a background session unread when its run finishes", () => {
    let state: SessionActivityMap = {};
    state = updateSessionRunning(state, "background", true, "active");
    state = updateSessionRunning(state, "background", false, "active");

    expect(state.background).toEqual({ running: false, unread: true });
  });

  it("does not mark the visible session unread when its run finishes", () => {
    let state: SessionActivityMap = {};
    state = updateSessionRunning(state, "active", true, "active");
    state = updateSessionRunning(state, "active", false, "active");

    expect(state.active).toEqual({ running: false, unread: false });
  });

  it("clears unread state when opened and removes deleted sessions", () => {
    const unread = {
      session: { running: false, unread: true },
    };

    expect(markSessionRead(unread, "session").session.unread).toBe(false);
    expect(removeSessionActivity(unread, "session")).toEqual({});
  });

  it("seeds busy/permission siblings as running, skipping active/idle/tracked", () => {
    const previous: SessionActivityMap = {
      tracked: { running: false, unread: true },
    };
    const next = seedRunningFromSnapshot(
      previous,
      [
        { chatId: "active", status: "busy" }, // skipped: it's the active chat
        { chatId: "busy-sib", status: "busy" }, // seeded
        { chatId: "perm-sib", status: "permission_required" }, // seeded
        { chatId: "idle-sib", status: "idle" }, // skipped: not running
        { chatId: "tracked", status: "busy" }, // skipped: already tracked
      ],
      "active",
    );

    expect(next["busy-sib"]).toEqual({ running: true, unread: false });
    expect(next["perm-sib"]).toEqual({ running: true, unread: false });
    expect(next.active).toBeUndefined();
    expect(next["idle-sib"]).toBeUndefined();
    // Tracked chat is left exactly as-is (live WS owns it).
    expect(next.tracked).toEqual({ running: false, unread: true });
  });

  it("returns the same map reference when nothing to seed", () => {
    const previous: SessionActivityMap = {};
    expect(
      seedRunningFromSnapshot(previous, [{ chatId: "a", status: "idle" }], null),
    ).toBe(previous);
  });
});
