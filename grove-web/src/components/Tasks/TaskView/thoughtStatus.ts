const STANDALONE_BOLD_HEADING = /^\s*(?:#{1,6}\s+)?\*\*(.+?)\*\*\s*[.:：。-]?\s*$/;

/**
 * Extract the latest Codex-style thought heading without exposing the
 * reasoning body. Codex emits these headings as standalone `**…**` lines.
 */
export function extractThoughtStatus(content: string): string {
  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(STANDALONE_BOLD_HEADING);
    const heading = match?.[1]?.replace(/\s+/g, " ").trim();
    if (heading) return heading;
  }
  return "Thinking";
}
