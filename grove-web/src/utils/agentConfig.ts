import type { AgentConfigSelection } from "../api/agentConfig";
import type { InstalledAgentConfig } from "../api/marketplace";

export function configForAgent(agent: InstalledAgentConfig): AgentConfigSelection {
  const snapshot = agent.capability_snapshot;
  if (snapshot?.uses_config_options && snapshot.config_options?.length) {
    return {
      source: "config_options",
      agent_id: agent.id,
      values: Object.fromEntries(
        snapshot.config_options.map((option) => [option.id, option.currentValue]),
      ),
    };
  }

  const modes = snapshot?.modes?.available ?? [];
  if (modes.length > 0) {
    return {
      source: "modes",
      agent_id: agent.id,
      mode_id: snapshot?.modes?.current ?? modes[0][0],
    };
  }

  return { source: "default", agent_id: agent.id };
}
