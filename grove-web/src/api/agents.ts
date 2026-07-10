// Agent discovery API

import { apiClient } from "./client";

export interface AgentCapabilities {
  /** [id, label] pairs. Empty when the agent has never connected. */
  models: [string, string][];
  modes: [string, string][];
  thought_levels: [string, string][];
}

export async function getAgentCapabilities(
  agentId: string,
  signal?: AbortSignal,
): Promise<AgentCapabilities> {
  return apiClient.get<AgentCapabilities>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/capabilities`,
    signal,
  );
}
