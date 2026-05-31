import { useEffect, useRef, useState } from "react";
import {
  fetchDashboard,
  type DashboardSnapshot,
  type AgentDisplayState,
  type ProjectDisplayStatus,
} from "../../api/dashboard";

const REFRESH_MS = 5000;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtDuration(secs: number): string {
  if (secs <= 0) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}

function relTime(ts: number, nowSecs: number): string {
  const diff = Math.max(0, nowSecs - ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const PROJECT_DOT: Record<ProjectDisplayStatus, string> = {
  active: "var(--color-success)",
  idle: "var(--color-text-muted)",
  empty: "var(--color-text-faint, var(--color-text-muted))",
};

const AGENT_DOT: Record<AgentDisplayState, string> = {
  active: "var(--color-success)",
  idle: "var(--color-text-muted)",
  unknown: "var(--color-text-faint, var(--color-text-muted))",
};

export function StatusBoard() {
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));
  const firstLoad = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await fetchDashboard();
        if (cancelled) return;
        setSnap(data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
      } finally {
        firstLoad.current = false;
        if (!cancelled) timer = setTimeout(tick, REFRESH_MS);
      }
    };
    void tick();

    // Drive relative-time labels without refetching.
    const clock = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 1000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(clock);
    };
  }, []);

  if (!snap && error) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-error)] text-lg">
        {error}
      </div>
    );
  }
  if (!snap) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-text-muted)] text-lg">
        Loading dashboard…
      </div>
    );
  }

  const t = snap.totals;

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] overflow-hidden select-none">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center font-extrabold text-[var(--color-bg)]"
               style={{ background: "linear-gradient(135deg, var(--color-highlight), #b45309)" }}>
            G
          </div>
          <span className="text-xl font-bold tracking-tight">
            Grove <span className="text-[var(--color-text-muted)] font-medium">· status</span>
          </span>
        </div>
        <div className="flex items-center gap-6 text-sm text-[var(--color-text-muted)]">
          <span>
            <b className="text-[var(--color-text)]">{t.total_projects}</b> projects
          </span>
          <span>
            <b className="text-[var(--color-success)]">{t.active_sessions}</b> live
          </span>
          <span>
            <b className="text-[var(--color-text)]">{t.total_sessions}</b> sessions
          </span>
          {error && <span className="text-[var(--color-warning)]">⚠ stale</span>}
        </div>
      </header>

      {/* Totals strip */}
      <div className="grid grid-cols-3 gap-px bg-[var(--color-border)] border-b border-[var(--color-border)]">
        <Stat label="Tokens · total" value={fmtTokens(t.tokens_total)} accent />
        <Stat label="Tokens · in" value={fmtTokens(t.tokens_in)} />
        <Stat label="Tokens · out" value={fmtTokens(t.tokens_out)} />
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 grid grid-cols-[1fr_340px] gap-px bg-[var(--color-border)]">
        {/* Projects */}
        <div className="bg-[var(--color-bg)] overflow-auto p-4">
          {snap.projects.length === 0 ? (
            <div className="h-full flex items-center justify-center text-[var(--color-text-muted)]">
              No projects yet.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {snap.projects.map((p) => (
                <div key={p.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ background: PROJECT_DOT[p.status], boxShadow: p.status === "active" ? "0 0 10px var(--color-success)" : undefined }} />
                      <span className="font-semibold truncate">{p.name}</span>
                      <span className="text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">{p.project_type}</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-[var(--color-text-muted)] shrink-0">
                      <span>{p.agents.length} {p.agents.length === 1 ? "agent" : "agents"}</span>
                      <span className="text-[var(--color-highlight)] font-medium tabular-nums">{fmtTokens(p.tokens_total)}</span>
                    </div>
                  </div>
                  {p.agents.length > 0 && (
                    <div className="divide-y divide-[var(--color-border)]">
                      {p.agents.map((a) => (
                        <div key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${a.state === "active" ? "animate-pulse" : ""}`}
                                style={{ background: AGENT_DOT[a.state] }} />
                          <span className="w-20 shrink-0 text-[var(--color-text-muted)] capitalize">{a.agent}</span>
                          <span className="flex-1 min-w-0 truncate">{a.label || "untitled"}</span>
                          <span className="w-14 text-right text-[var(--color-text-muted)] tabular-nums">{fmtDuration(a.session_uptime_secs)}</span>
                          <span className="w-16 text-right text-[var(--color-highlight)] tabular-nums">{fmtTokens(a.tokens_total)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Activity feed */}
        <div className="bg-[var(--color-bg)] overflow-auto">
          <div className="px-4 py-2.5 text-[11px] uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-bg)]">
            Activity
          </div>
          {snap.activity.length === 0 ? (
            <div className="px-4 py-6 text-sm text-[var(--color-text-muted)]">No recent activity.</div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {snap.activity.map((ev) => (
                <div key={ev.id} className="px-4 py-2.5">
                  <div className="text-sm truncate">{ev.label}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">{relTime(ev.occurred_at, nowSecs)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="px-8 py-1.5 text-[11px] text-[var(--color-text-muted)] border-t border-[var(--color-border)] flex items-center justify-between">
        <span>Updated {relTime(snap.generated_at, nowSecs)} · refreshes every {REFRESH_MS / 1000}s</span>
        <span className="tabular-nums">{new Date(nowSecs * 1000).toLocaleTimeString()}</span>
      </footer>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-[var(--color-bg)] px-8 py-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${accent ? "text-[var(--color-highlight)]" : ""}`}>{value}</div>
    </div>
  );
}
