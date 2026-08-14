import { describe, expect, it } from "vitest";

import type { MemoryRelation } from "../../api/memory";
import { selectVisibleRelations } from "./memoryGraphRelations";

function relation(id: string, source: string, target: string, score: number): MemoryRelation {
  return {
    id,
    project_id: "project",
    source_entity_id: source,
    target_entity_id: target,
    relation_type: "related",
    description: "",
    base_score: score,
    access_count: 0,
    score,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("selectVisibleRelations", () => {
  it("keeps every visible node at or below the configured degree", () => {
    const nodes = new Map(["hub", "a", "b", "c", "d", "e"].map((id) => [id, true]));
    const selected = selectVisibleRelations([
      relation("hub-a", "hub", "a", 100),
      relation("hub-b", "hub", "b", 90),
      relation("hub-c", "hub", "c", 80),
      relation("hub-d", "hub", "d", 70),
      relation("hub-e", "hub", "e", 60),
      relation("a-b", "a", "b", 50),
      relation("c-d", "c", "d", 40),
    ], nodes, 3);

    const degrees = new Map<string, number>();
    for (const item of selected) {
      degrees.set(item.source_entity_id, (degrees.get(item.source_entity_id) ?? 0) + 1);
      degrees.set(item.target_entity_id, (degrees.get(item.target_entity_id) ?? 0) + 1);
    }
    expect(Math.max(...degrees.values())).toBeLessThanOrEqual(3);
    expect(selected.filter((item) => item.source_entity_id === "hub")).toHaveLength(3);
  });

  it("uses only the strongest relation between a pair and ignores hidden nodes", () => {
    const nodes = new Map([["a", true], ["b", true]]);
    const selected = selectVisibleRelations([
      relation("weak", "a", "b", 20),
      relation("strong", "b", "a", 80),
      relation("hidden", "a", "c", 100),
    ], nodes, 3);

    expect(selected.map((item) => item.id)).toEqual(["strong"]);
  });

  it("protects a scarce node from being isolated by a saturated neighbour", () => {
    const nodes = new Map(["hub", "a", "b", "c", "outlier"].map((id) => [id, true]));
    const selected = selectVisibleRelations([
      relation("hub-a", "hub", "a", 100),
      relation("hub-b", "hub", "b", 90),
      relation("hub-c", "hub", "c", 80),
      relation("a-b", "a", "b", 70),
      relation("b-c", "b", "c", 60),
      relation("hub-outlier", "hub", "outlier", 10),
    ], nodes, 3);

    expect(selected.some((item) => item.id === "hub-outlier")).toBe(true);
    const covered = new Set(selected.flatMap((item) => [item.source_entity_id, item.target_entity_id]));
    expect(covered).toEqual(new Set(nodes.keys()));
  });
});
