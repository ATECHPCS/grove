import { useEffect, useState } from "react";
import "./office.css";
import { fetchDashboard, type DashboardSnapshot } from "../../api/dashboard";
import { PhaserGame } from "./town/PhaserGame";

const REFRESH_MS = 2_000;
const SEAT_COUNT = 13; // desks in the office map (office2.json spawns)

/**
 * Standalone office TV-wall display (`/groove-dashboard`). A live pixel office
 * (Phaser) where every Grove agent session is a worker sitting at a desk,
 * wandering, and popping chat bubbles — driven by the dashboard snapshot. The
 * HUD (header, stats rail, activity ticker) overlays the canvas. Read-only and
 * privacy-safe (snapshot carries no paths/branches/prompts).
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

  const t = snap?.totals;
  const sessions = t?.total_sessions ?? 0;
  const overflow = Math.max(0, sessions - SEAT_COUNT);

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] overflow-hidden select-none">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-[var(--color-border)] shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center font-extrabold text-[var(--color-bg)]"
            style={{ background: "linear-gradient(135deg, var(--color-highlight), #b45309)" }}
          >
            G
          </div>
          <span className="text-2xl font-bold tracking-tight">
            Grove <span className="text-[var(--color-text-muted)] font-medium">· the office</span>
          </span>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <span className="text-[var(--color-text-muted)]">
            <b className="text-[var(--color-success)]">{t?.active_sessions ?? 0}</b> working ·{" "}
            <b className="text-[var(--color-text)]">{sessions}</b> sessions
            {overflow > 0 && <span className="text-[var(--color-text-muted)]"> · +{overflow} in lobby</span>}
          </span>
          <span className="flex items-center gap-2 text-[var(--color-text-muted)]">
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: stale ? "var(--color-warning)" : "var(--color-success)" }}
            />
            {stale ? "reconnecting" : "live"}
          </span>
          <span className="tabular-nums text-[var(--color-text-muted)]">{clock}</span>
        </div>
      </header>

      {/* Office canvas (full width — stats live on the /dashboard board) */}
      <main className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
        <PhaserGame snapshot={snap} />
        {!snap && (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--color-text-muted)] text-lg">
            Opening the office…
          </div>
        )}
      </main>
    </div>
  );
}
