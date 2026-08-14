import type { MemoryRelation } from "../../api/memory";

export function selectVisibleRelations(
  relations: MemoryRelation[],
  visibleNodes: ReadonlyMap<string, unknown>,
  maximumDegree: number,
) {
  const strongestByPair = new Map<string, MemoryRelation>();
  for (const relation of relations) {
    if (relation.source_entity_id === relation.target_entity_id) continue;
    if (!visibleNodes.has(relation.source_entity_id) || !visibleNodes.has(relation.target_entity_id)) continue;
    const pair = [relation.source_entity_id, relation.target_entity_id].sort().join("\u0000");
    const current = strongestByPair.get(pair);
    if (!current || relation.score > current.score || (relation.score === current.score && relation.id.localeCompare(current.id) < 0)) {
      strongestByPair.set(pair, relation);
    }
  }

  const candidates = [...strongestByPair.values()];
  const candidatesByNode = new Map<string, MemoryRelation[]>();
  for (const relation of candidates) {
    for (const nodeId of [relation.source_entity_id, relation.target_entity_id]) {
      const nodeCandidates = candidatesByNode.get(nodeId) ?? [];
      nodeCandidates.push(relation);
      candidatesByNode.set(nodeId, nodeCandidates);
    }
  }

  const degrees = new Map<string, number>();
  const selectedIds = new Set<string>();
  const selected: MemoryRelation[] = [];
  const degree = (nodeId: string) => degrees.get(nodeId) ?? 0;
  const otherEnd = (relation: MemoryRelation, nodeId: string) => relation.source_entity_id === nodeId
    ? relation.target_entity_id
    : relation.source_entity_id;
  const add = (relation: MemoryRelation) => {
    if (selectedIds.has(relation.id)) return false;
    if (degree(relation.source_entity_id) >= maximumDegree || degree(relation.target_entity_id) >= maximumDegree) return false;
    selectedIds.add(relation.id);
    selected.push(relation);
    degrees.set(relation.source_entity_id, degree(relation.source_entity_id) + 1);
    degrees.set(relation.target_entity_id, degree(relation.target_entity_id) + 1);
    return true;
  };

  // Give scarce nodes first access to an edge. Prefer an uncovered neighbour so
  // one edge covers two nodes, then use relation strength as the tie-breaker.
  const coverageOrder = [...candidatesByNode.keys()].sort((left, right) =>
    (candidatesByNode.get(left)?.length ?? 0) - (candidatesByNode.get(right)?.length ?? 0)
      || left.localeCompare(right));
  for (const nodeId of coverageOrder) {
    if (degree(nodeId) > 0) continue;
    const best = [...(candidatesByNode.get(nodeId) ?? [])]
      .filter((relation) => degree(otherEnd(relation, nodeId)) < maximumDegree)
      .sort((left, right) => {
        const leftOther = otherEnd(left, nodeId);
        const rightOther = otherEnd(right, nodeId);
        return degree(leftOther) - degree(rightOther)
          || (candidatesByNode.get(leftOther)?.length ?? 0) - (candidatesByNode.get(rightOther)?.length ?? 0)
          || right.score - left.score
          || left.id.localeCompare(right.id);
      })[0];
    if (best) add(best);
  }

  // Once coverage is established, spend the remaining degree budget on the
  // strongest relations.
  for (const relation of candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))) {
    add(relation);
  }
  return selected;
}
