import { describe, expect, it } from "vitest";
import {
  markSessionRead,
  removeSessionActivity,
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
});
