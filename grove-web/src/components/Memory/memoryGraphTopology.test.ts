import { describe, expect, it } from "vitest";
import type { MemoryRelation } from "../../api/memory";
import { selectMemoryGraphTopology } from "./memoryGraphTopology";

const relation = (id: string, source: string, target: string, score: number): MemoryRelation => ({
  id,
  project_id: "project",
  source_entity_id: source,
  target_entity_id: target,
  score,
  relation_type: "related",
  description: "",
  base_score: score,
  access_count: 0,
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
});

describe("selectMemoryGraphTopology", () => {
  it("includes two-hop nodes and all induced links between them", () => {
    const topology = selectMemoryGraphTopology([
      relation("ab", "a", "b", 90),
      relation("bc", "b", "c", 80),
      relation("ac", "a", "c", 70),
      relation("cd", "c", "d", 60),
    ], "a", 2, 12);

    expect([...topology.nodeIds]).toEqual(["a", "b", "c", "d"]);
    expect([...topology.relationIds].sort()).toEqual(["ab", "ac", "bc", "cd"]);
  });

  it("keeps the strongest neighbors when the node limit is reached", () => {
    const topology = selectMemoryGraphTopology([
      relation("ab", "a", "b", 60),
      relation("ac", "a", "c", 95),
      relation("ad", "a", "d", 80),
    ], "a", 1, 3);

    expect(topology.nodeIds).toEqual(new Set(["a", "c", "d"]));
    expect(topology.relationIds).toEqual(new Set(["ac", "ad"]));
  });
});
