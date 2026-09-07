// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";

describe("ApiClient JSON responses", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects a SPA fallback page returned for a missing API route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })));

    await expect(apiClient.get("/api/v1/missing-route")).rejects.toMatchObject({
      status: 200,
      message: expect.stringContaining("Restart Grove"),
    });
  });

  it("continues to parse valid API JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(apiClient.get("/api/v1/example")).resolves.toEqual({ ok: true });
  });
});
