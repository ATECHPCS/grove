import type { ExtensionArtifact } from "../../api/extensions";
import type { Plugin } from "../../api/plugins";

export function resolveInstalledPlugin(item: ExtensionArtifact, plugins: Plugin[]): Plugin | undefined {
  if (item.kind !== "plugin" || !item.installed_plugin_id) return undefined;
  return plugins.find((candidate) => candidate.id === item.installed_plugin_id);
}
