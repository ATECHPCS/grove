import type { DashboardTotals } from "../../api/dashboard";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function Metric({ label, value, accent, big }: { label: string; value: string; accent?: boolean; big?: boolean }) {
  return (
    <div className="px-5 py-3 border-b border-[var(--color-border)]">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={`${big ? "text-3xl" : "text-2xl"} font-bold tabular-nums ${accent ? "text-[var(--color-highlight)]" : ""}`}>
        {value}
      </div>
    </div>
  );
}

export function StatsRail({ totals }: { totals: DashboardTotals }) {
  return (
    <aside className="w-[240px] shrink-0 bg-[var(--color-bg-secondary)] border-l border-[var(--color-border)] flex flex-col">
      <div className="px-5 py-3 border-b border-[var(--color-border)] text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
        The numbers
      </div>
      <Metric label="Tokens · total" value={fmtTokens(totals.tokens_total)} accent big />
      <div className="grid grid-cols-2">
        <div className="border-r border-[var(--color-border)]">
          <Metric label="In" value={fmtTokens(totals.tokens_in)} />
        </div>
        <Metric label="Out" value={fmtTokens(totals.tokens_out)} />
      </div>
      <Metric label="Live sessions" value={`${totals.active_sessions}`} />
      <Metric label="Sessions" value={`${totals.total_sessions}`} />
      <Metric label="Projects" value={`${totals.total_projects}`} />
    </aside>
  );
}
