import { apiClient } from "./client";

export type ExtensionKind = "skill" | "plugin" | "mcp";

export interface ExtensionArtifact {
  kind: ExtensionKind;
  name: string;
  description: string;
  version: string | null;
  source: string;
  repo_key: string;
  repo_path: string;
  relative_path: string;
  manifest: Record<string, unknown> | null;
  install_status: "not_installed" | "installed" | "partial";
  installed_agents: string[];
}

export async function exploreExtensions(params?: { kind?: string; search?: string }): Promise<ExtensionArtifact[]> {
  const query = new URLSearchParams();
  if (params?.kind && params.kind !== "all") query.set("kind", params.kind);
  if (params?.search) query.set("search", params.search);
  return apiClient.get(`/api/v1/extensions/explore${query.size ? `?${query}` : ""}`);
}

export async function createManagedMcp(manifest: Record<string, unknown>): Promise<{ ok: boolean; source: string }> {
  return apiClient.post("/api/v1/extensions/mcp", { manifest });
}

export async function installMcp(input: {
  repo_key: string;
  repo_path: string;
  scope: "global" | "project";
  project_path?: string;
  agent_ids: string[];
  runtime: { kind: "remote" | "package"; index: number };
  values: Record<string, string>;
}): Promise<{ ok: boolean }> {
  return apiClient.post("/api/v1/extensions/mcp/install", input);
}

export async function installCatalogPlugin(repo_key: string, repo_path: string): Promise<{ ok: boolean }> {
  return apiClient.post("/api/v1/extensions/plugin/install", { repo_key, repo_path });
}
