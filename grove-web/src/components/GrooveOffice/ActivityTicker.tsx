import type { DashboardActivity } from "../../api/dashboard";

// Ambient filler lines for quiet periods. Visually distinct (muted, italic, no
// numbers) so they never imply real work — per the spec's data policy.
const AMBIENT = [
  "the office hums quietly",
  "coffee machine is warm",
  "agents standing by",
  "all desks tidy",
];

export function ActivityTicker({ activity }: { activity: DashboardActivity[] }) {
  const hasReal = activity.length > 0;
  const items = hasReal ? activity : [];

  // Duplicate the content so the marquee can loop seamlessly (translateX -50%).
  const render = (keyPrefix: string) => (
    <div className="inline-flex items-center" aria-hidden={keyPrefix === "b"}>
      {hasReal
        ? items.map((ev) => (
            <span key={`${keyPrefix}-${ev.id}`} className="inline-flex items-center px-6 py-2 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] mr-2.5" />
              {ev.label}
            </span>
          ))
        : AMBIENT.map((line, i) => (
            <span key={`${keyPrefix}-amb-${i}`} className="inline-flex items-center px-6 py-2 text-sm italic text-[var(--color-text-muted)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-faint,var(--color-text-muted))] mr-2.5" />
              {line}
            </span>
          ))}
    </div>
  );

  return (
    <footer className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden">
      <div className="office-ticker__track">
        {render("a")}
        {render("b")}
      </div>
    </footer>
  );
}
