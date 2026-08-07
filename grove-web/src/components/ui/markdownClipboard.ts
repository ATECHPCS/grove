function rangeFullyContainsNode(range: Range, node: Node): boolean {
  const nodeRange = document.createRange();
  nodeRange.selectNodeContents(node);
  return range.compareBoundaryPoints(Range.START_TO_START, nodeRange) <= 0
    && range.compareBoundaryPoints(Range.END_TO_END, nodeRange) >= 0;
}

/**
 * Return Markdown source only when the selection covers complete rendered
 * Markdown blocks. Partial text selections must use the browser's native copy
 * behavior so the clipboard matches the visible highlight exactly.
 */
export function selectedMarkdownForRange(root: HTMLElement, range: Range): string | null {
  const allBlocks = Array.from(root.querySelectorAll<HTMLElement>("[data-grove-markdown-source]"))
    .filter((block) => range.intersectsNode(block));
  const blocks = allBlocks.filter(
    (block) => !allBlocks.some((other) => other !== block && other.contains(block)),
  );
  if (blocks.length === 0 || !blocks.every((block) => rangeFullyContainsNode(range, block))) {
    return null;
  }
  const markdown = blocks
    .map((block) => block.dataset.groveMarkdownSource)
    .filter((source): source is string => Boolean(source))
    .join("\n\n");
  return markdown || null;
}
