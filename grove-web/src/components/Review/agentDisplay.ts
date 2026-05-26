import { resolveAgentIcon } from "../../utils/agentIcon";

/** Build display string from agent + role. Model is rendered separately by callers. */
export function formatAgentDisplay(agent: string, role: string): string {
  const info = resolveAgentIcon(agent);
  const name = info.label || agent || 'Unknown';
  return role ? `${name} (${role})` : name;
}
