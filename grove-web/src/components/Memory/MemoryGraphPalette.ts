const MEMORY_GRAPH_COLORS = ["#55b98b", "#b37ad9", "#e8bd58", "#e98273", "#69a8d8", "#8bc46b"];

export function memoryCategoryColor(category: string, categories: string[]) {
  const index = Math.max(0, categories.indexOf(category));
  return MEMORY_GRAPH_COLORS[index % MEMORY_GRAPH_COLORS.length];
}
