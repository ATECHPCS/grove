import { useEffect, useState } from "react";
import "./office.css";
import { fetchDashboard, type DashboardSnapshot } from "../../api/dashboard";
import { ProjectRoom } from "./ProjectRoom";
import { StatsRail } from "./StatsRail";
import { ActivityTicker } from "./ActivityTicker";

const REFRESH_MS = 10_000;

/**
 * Standalone office-floor TV wall display (`/groove-dashboard`). One room per
 * Grove project, animated agent "fellows" per session, a stats rail, and an
 * activity ticker. Read-only and privacy-safe (server snapshot carries no
 * paths/branches/prompts). Keeps the last good snapshot on a transient API
 * failure and shows a subtle stale indicator.
 */
export function OfficeFloor() {
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
  const [stale, setStale] = useState(false);
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await fetchDashboard();
        if (cancelled) return;
        setSnap(data);
        setStale(false);
      } catch {
        // Keep the last good snapshot on screen; just flag it stale.
        if (!cancelled) setStale(true);
      } finally {
        if (!cancelled) timer = setTimeout(tick, REFRESH_MS);
      }
    };
    void tick();

    const c = setInterval(() => setClock(new Date().toLocaleTimeString()), 1000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(c);
    };
  }, []);

  if (!snap) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-text-muted)] text-lg">
        Opening the office…
      </div>
    );
  }

  const t = snap.totals;

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] overflow-hidden select-none">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-[var(--color-border)] shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center font-extrabold text-[var(--color-bg)]"
               style={{ background: "linear-gradient(135deg, var(--color-highlight), #b45309)" }}>
            G
          </div>
          <span className="text-2xl font-bold tracking-tight">
            Grove <span className="text-[var(--color-text-muted)] font-medium">· the office</span>
          </span>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <span className="text-[var(--color-text-muted)]">
            <b className="text-[var(--color-success)]">{t.active_sessions}</b> working ·{" "}
            <b className="text-[var(--color-text)]">{t.total_projects}</b> rooms
          </span>
          <span className="flex items-center gap-2 text-[var(--color-text-muted)]">
            <span className="w-2 h-2 rounded-full" style={{ background: stale ? "var(--color-warning)" : "var(--color-success)" }} />
            {stale ? "reconnecting" : "live"}
          </span>
          <span className="tabular-nums text-[var(--color-text-muted)]">{clock}</span>
        </div>
      </header>

      {/* Floor + rail */}
      <div className="flex-1 min-h-0 flex">
        <main className="flex-1 min-w-0 overflow-auto p-6">
          {snap.projects.length === 0 ? (
            <div className="h-full flex items-center justify-center text-[var(--color-text-muted)]">
              No Grove projects yet — the office is empty.
            </div>
          ) : (
            <div
              className="grid gap-5"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
            >
              {snap.projects.map((p) => (
                <ProjectRoom key={p.id} project={p} />
              ))}
            </div>
          )}
        </main>
        <StatsRail totals={t} />
      </div>

      {/* Ticker */}
      <ActivityTicker activity={snap.activity} />
    </div>
  );
}
