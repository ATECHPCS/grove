import { describe, expect, it } from "vitest";
import { formatProviderError } from "./providerErrors";

describe("formatProviderError", () => {
  it("turns ElevenLabs voice permission payloads into an actionable message", () => {
    const reason = {
      message: 'ElevenLabs returned HTTP 401: {"detail":{"message":"missing permission voices_read"}}',
    };
    expect(formatProviderError(reason, { fallback: "Connection failed" })).toBe(
      "ElevenLabs API key needs Voices access. Enable Voices for this restricted key, then test the connection again.",
    );
  });

  it("identifies a stale backend response without exposing the browser parse error", () => {
    expect(formatProviderError(new TypeError("The string did not match the expected pattern."), {
      fallback: "Controls unavailable",
      backendRestartMessage: "Restart Grove to load Agent Voice Provider controls.",
    })).toBe("Restart Grove to load Agent Voice Provider controls.");
  });

  it("removes raw vendor JSON from unknown provider errors", () => {
    expect(formatProviderError({ message: 'Provider returned HTTP 403: {"request_id":"secret"}' }, {
      fallback: "Connection failed",
    })).toBe("Provider returned HTTP 403");
  });
});
