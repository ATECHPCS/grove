export type PlanPriority = "high" | "medium" | "low";

export interface PlanEntry {
  content: string;
  status: string;
  /** Missing on Grove history written before priorities were preserved. */
  priority?: PlanPriority;
}

const PRIORITY_RANK: Record<PlanPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function planPriority(value: unknown): PlanPriority | undefined {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : undefined;
}

export function normalizePlanEntries(value: unknown): PlanEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.content !== "string") return [];
    const status =
      candidate.status === "inprogress"
        ? "in_progress"
        : typeof candidate.status === "string"
          ? candidate.status
          : "pending";
    return [
      {
        content: candidate.content,
        status,
        priority: planPriority(candidate.priority),
      },
    ];
  });
}

/** Sort by ACP priority while preserving the Agent's order within each tier. */
export function sortPlanEntries(entries: PlanEntry[]): PlanEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        (left.entry.priority ? PRIORITY_RANK[left.entry.priority] : 3) -
          (right.entry.priority ? PRIORITY_RANK[right.entry.priority] : 3) ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
}

export function shouldOpenPlan(entries: PlanEntry[]): boolean {
  return (
    entries.length > 0 &&
    !entries.every((entry) => entry.status === "completed")
  );
}

/**
 * Plan updates may close an expanded panel once all work is complete, but
 * must not open it on their own. Auto-opening grows the floating composer by
 * several rows while the Agent is streaming; bottom-follow then pushes the
 * user's just-sent message above the viewport and keeps pulling the reader
 * back down. The Todo pill remains available for an explicit open.
 */
export function nextPlanVisibility(
  currentlyOpen: boolean,
  entries: PlanEntry[],
): boolean {
  return currentlyOpen && shouldOpenPlan(entries);
}
