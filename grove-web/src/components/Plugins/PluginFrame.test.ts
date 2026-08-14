import { describe, expect, it } from "vitest";
import { resolvePluginEntry } from "./pluginEntry";

describe("resolvePluginEntry", () => {
  const manifest = {
    contributes: {
      panel: { entry: "dist/panel.html" },
      sidebar: { entry: "dist/sidebar.html" },
    },
  };

  it("loads the entry declared for the requested contribution", () => {
    expect(resolvePluginEntry(manifest, "panel")).toBe("dist/panel.html");
    expect(resolvePluginEntry(manifest, "sidebar")).toBe("dist/sidebar.html");
  });

  it("falls back only when that contribution has no declared entry", () => {
    expect(resolvePluginEntry({ contributes: { sidebar: {} } }, "sidebar")).toBe("index.html");
  });
});
