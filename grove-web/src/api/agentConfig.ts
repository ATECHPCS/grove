export type ConfigOptionValue = string | boolean;

export type AgentConfigSelection =
  | { source: "default"; agent_id?: string }
  | {
      source: "config_options";
      agent_id?: string;
      values: Record<string, ConfigOptionValue>;
    }
  | { source: "modes"; agent_id?: string; mode_id: string };
