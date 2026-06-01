import type { DashboardProject } from "../../api/dashboard";
import { AgentFellow } from "./AgentFellow";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

const STATUS_DOT: Record<DashboardProject["status"], string> = {
  active: "var(--color-success)",
  idle: "var(--color-text-muted)",
  empty: "var(--color-text-faint, var(--color-text-muted))",
};

/** One Grove project = one office room with its agent fellows on the floor. */
export function ProjectRoom({ project }: { project: DashboardProject }) {
  const live = project.status === "active";
  return (
    <div
      className="flex flex-col rounded-2xl border bg-[var(--color-bg-secondary)] overflow-hidden"
      style={{
        borderColor: live ? "color-mix(in srgb, var(--color-success) 40%, var(--color-border))" : "var(--color-border)",
        boxShadow: live ? "0 0 24px -8px color-mix(in srgb, var(--color-success) 50%, transparent)" : undefined,
      }}
    >
      {/* Room nameplate */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATUS_DOT[project.status] }} />
          <span className="font-semibold truncate">{project.name}</span>
        </div>
        <span className="text-[var(--color-highlight)] text-sm font-medium tabular-nums shrink-0">
          {fmtTokens(project.tokens_total)}
        </span>
      </div>

      {/* Floor */}
      <div className="flex-1 min-h-[120px] flex flex-wrap items-end justify-center gap-x-3 gap-y-4 px-3 pt-5 pb-3"
           style={{
             backgroundImage:
               "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-border) 60%, transparent) 1px, transparent 0)",
             backgroundSize: "16px 16px",
           }}>
        {project.agents.length === 0 ? (
          <div className="self-center text-xs text-[var(--color-text-muted)] py-6">empty room</div>
        ) : (
          project.agents.map((a) => <AgentFellow key={a.id} agent={a} />)
        )}
      </div>
    </div>
  );
}
