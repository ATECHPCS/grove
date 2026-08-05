export const LARGE_MARKDOWN_PREVIEW_THRESHOLD = 30_000;

export function isVirtualizedMarkdownPreview(fileName: string, content: string): boolean {
  return /\.(md|markdown)$/i.test(fileName) && content.length > LARGE_MARKDOWN_PREVIEW_THRESHOLD;
}
