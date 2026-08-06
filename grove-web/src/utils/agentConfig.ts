import type { AgentConfigSelection } from "../api/agentConfig";
import type { InstalledAgentConfig } from "../api/marketplace";
import type { SessionConfigOption } from "../api/tasks";

export function configForAgent(agent: InstalledAgentConfig): AgentConfigSelection {
  const snapshot = agent.capability_snapshot;
  if (snapshot?.uses_config_options) {
    return {
      source: "config_options",
      agent_id: agent.id,
      // ACP currentValue is the session default, not a persisted override.
      values: {},
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

export function reconcileAgentConfig(
  config: AgentConfigSelection,
  agent: InstalledAgentConfig,
): AgentConfigSelection {
  const snapshot = agent.capability_snapshot;
  if (!snapshot) return config;

  if (snapshot.uses_config_options) {
    const options = snapshot.config_options ?? [];
    const values = config.source === "config_options" && config.agent_id === agent.id
      ? Object.fromEntries(
          Object.entries(config.values).filter(([id, value]) => {
            const option = options.find((candidate) => candidate.id === id);
            return option ? configOptionAccepts(option, value) : false;
          }),
        )
      : {};
    return { source: "config_options", agent_id: agent.id, values };
  }

  const modes = snapshot.modes?.available ?? [];
  if (modes.length > 0) {
    const available = new Set(modes.map(([id]) => id));
    const modeId = config.source === "modes" && config.agent_id === agent.id
      && available.has(config.mode_id)
      ? config.mode_id
      : snapshot.modes?.current ?? modes[0][0];
    return { source: "modes", agent_id: agent.id, mode_id: modeId };
  }

  return { source: "default", agent_id: agent.id };
}

function configOptionAccepts(
  option: SessionConfigOption,
  value: string | boolean,
): boolean {
  if (option.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  return option.options.some((entry) =>
    "options" in entry
      ? entry.options.some((candidate) => candidate.value === value)
      : entry.value === value,
  );
}
