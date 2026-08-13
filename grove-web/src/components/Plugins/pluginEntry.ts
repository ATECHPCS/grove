export type PluginUiContribution = "panel" | "sidebar";

export type PluginUiManifest = {
  contributes?: Partial<Record<PluginUiContribution, { entry?: string }>>;
};

/** Resolve the entry declared for the surface hosting a plugin frame. */
export function resolvePluginEntry(
  manifest: PluginUiManifest,
  contribution: PluginUiContribution,
): string {
  const entry = manifest.contributes?.[contribution]?.entry;
  return typeof entry === "string" && entry ? entry : "index.html";
}
