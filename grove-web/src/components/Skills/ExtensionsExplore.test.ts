import { describe, expect, it } from "vitest";
import type { ExtensionArtifact } from "../../api/extensions";
import type { Plugin } from "../../api/plugins";
import { resolveInstalledPlugin } from "./installedPlugin";

function plugin(id: string, name: string): Plugin {
  return {
    id,
    name,
    version: "1.0.0",
    source: "dev",
    local_path: `/plugins/${name}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function artifact(installedPluginId: string): ExtensionArtifact {
  return {
    kind: "plugin",
    name: "second",
    description: "",
    version: "2.0.0",
    source: "plugin:second",
    repo_key: "pl-second",
    repo_path: "",
    relative_path: "",
    manifest: null,
    install_status: "installed",
    installed_agents: [],
    installed_plugin_id: installedPluginId,
  };
}

describe("resolveInstalledPlugin", () => {
  it("uses the backend plugin id when catalog paths are empty", () => {
    const plugins = [plugin("pl-first", "first"), plugin("pl-second", "second")];

    expect(resolveInstalledPlugin(artifact("pl-second"), plugins)?.name).toBe("second");
  });
});
