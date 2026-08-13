import type { MemoryRelation } from "../../api/memory";

export interface MemoryGraphTopology {
  nodeIds: Set<string>;
  relationIds: Set<string>;
}

export function selectMemoryGraphTopology(
  relations: MemoryRelation[],
  focusedNodeId: string,
  maxDepth = 2,
  maxNodes = 12,
): MemoryGraphTopology {
  const adjacency = new Map<string, Array<{ nodeId: string; relation: MemoryRelation }>>();
  for (const relation of relations) {
    const source = adjacency.get(relation.source_entity_id) ?? [];
    source.push({ nodeId: relation.target_entity_id, relation });
    adjacency.set(relation.source_entity_id, source);
    const target = adjacency.get(relation.target_entity_id) ?? [];
    target.push({ nodeId: relation.source_entity_id, relation });
    adjacency.set(relation.target_entity_id, target);
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => right.relation.score - left.relation.score);
  }

  const nodeIds = new Set([focusedNodeId]);
  let frontier = [focusedNodeId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0 && nodeIds.size < maxNodes; depth += 1) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const neighbor of adjacency.get(nodeId) ?? []) {
        if (nodeIds.has(neighbor.nodeId)) continue;
        nodeIds.add(neighbor.nodeId);
        next.push(neighbor.nodeId);
        if (nodeIds.size >= maxNodes) break;
      }
      if (nodeIds.size >= maxNodes) break;
    }
    frontier = next;
  }

  const relationIds = new Set(relations
    .filter((relation) => nodeIds.has(relation.source_entity_id) && nodeIds.has(relation.target_entity_id))
    .map((relation) => relation.id));
  return { nodeIds, relationIds };
}
