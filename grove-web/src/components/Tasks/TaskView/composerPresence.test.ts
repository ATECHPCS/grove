import { describe, expect, it } from "vitest";
import { composerPresenceUpdate } from "./composerPresence";

describe("composer presence updates", () => {
  it("keeps transient empty input from interrupting a text expansion", () => {
    expect(composerPresenceUpdate(false, false, true)).toBe("settling-empty");
    expect(composerPresenceUpdate(true, false, true)).toBe("present");
  });

  it("updates ordinary content and attachment states immediately", () => {
    expect(composerPresenceUpdate(true, false, false)).toBe("present");
    expect(composerPresenceUpdate(false, true, false)).toBe("present");
    expect(composerPresenceUpdate(false, false, false)).toBe("absent");
  });
});
