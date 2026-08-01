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
