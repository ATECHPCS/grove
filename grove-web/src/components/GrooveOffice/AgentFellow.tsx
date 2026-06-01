import { resolveAgentIcon } from "../../utils/agentIcon";
import type { DashboardAgent } from "../../api/dashboard";
import { PixelBody } from "./PixelBody";

/** Brand shirt colour per agent (concrete hex so the SVG body + color-mix
 *  render reliably). Falls back to the Blitz orange. */
const BRAND: Record<string, string> = {
  claude: "#d97757",
  codex: "#10a37f",
  gemini: "#4285f4",
  copilot: "#8957e5",
  cursor: "#6b7280",
  qwen: "#615ced",
  kimi: "#7c3aed",
  opencode: "#0ea5e9",
  junie: "#ff4d6d",
  trae: "#e11d48",
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

const PIP: Record<DashboardAgent["state"], string> = {
  active: "var(--color-success)",
  idle: "var(--color-text-muted)",
  unknown: "var(--color-text-faint, var(--color-text-muted))",
};

/** One animated office worker = one agent session. Head is the official agent
 *  icon; the desk screen scrolls "code" while the agent is active. */
export function AgentFellow({ agent }: { agent: DashboardAgent }) {
  const info = resolveAgentIcon(agent.agent);
  const Icon = info.Component;
  const brand = BRAND[agent.agent] ?? "#f0883e";

  return (
    <div
      className="office-fellow"
      data-state={agent.state}
      title={`${info.label || agent.agent} · ${agent.label} · ${fmtTokens(agent.tokens_total)} tokens`}
    >
      <span className="office-fellow__pip" style={{ background: PIP[agent.state] }} />
      <div className="office-fellow__head">
        <Icon size={22} />
      </div>
      <PixelBody shirt={brand} />
      <div className="office-fellow__desk">
        <div className="office-fellow__screen" />
      </div>
      <span className="office-fellow__name">{info.label || agent.agent}</span>
      <span className="office-fellow__tokens">{fmtTokens(agent.tokens_total)}</span>
    </div>
  );
}
