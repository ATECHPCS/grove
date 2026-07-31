type EditPathSource = {
  locations?: Array<{ path: string }>;
  input?: Array<{ label: string; value: string }>;
  content?: string;
};

function cleanPath(path: string): string {
  return path.trim().replace(/^['"]|['"]$/g, "");
}

function pathsFromPatchText(text: string): string[] {
  const paths: string[] = [];
  const add = (path: string | undefined) => {
    if (!path || path === "/dev/null") return;
    const cleaned = cleanPath(path);
    if (cleaned) paths.push(cleaned);
  };

  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    add(match[2]);
  }
  for (const match of text.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm)) {
    add(match[1]);
  }
  return paths;
}

/** Extract edited file paths even when the ACP event omitted `locations`. */
export function extractEditToolPaths(source: EditPathSource): string[] {
  const paths: string[] = [];
  const add = (path: string) => {
    const cleaned = cleanPath(path);
    if (cleaned && cleaned !== "/dev/null") paths.push(cleaned);
  };

  for (const location of source.locations ?? []) add(location.path);

  // ACP locations and Diff paths are authoritative. Do not then mix in a
  // relative path parsed from input for the same file (for example
  // `/repo/client.go` plus `client.go`), which would create duplicate chips.
  if (paths.length > 0) return Array.from(new Set(paths));

  for (const field of source.input ?? []) {
    if (/\b(path|file|files)\b/i.test(field.label)) add(field.value);
    for (const path of pathsFromPatchText(field.value)) add(path);
  }
  for (const path of pathsFromPatchText(source.content ?? "")) add(path);

  return Array.from(new Set(paths));
}

function normalizeForMatch(path: string): string {
  return cleanPath(path)
    .replaceAll("\\", "/")
    .replace(/^[ab]\//, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function pathsMatch(left: string, right: string): boolean {
  const a = normalizeForMatch(left);
  const b = normalizeForMatch(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function splitGitDiffs(content: string): Array<{ path: string; diff: string }> {
  const starts = Array.from(content.matchAll(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/gm));
  return starts.map((match, index) => ({
    path: match[2].trim(),
    diff: content.slice(
      match.index ?? 0,
      starts[index + 1]?.index ?? content.length,
    ).trimEnd(),
  }));
}

/** Return only the diff that can be attributed to one file. */
export function extractDiffForEditPath(
  content: string | undefined,
  path: string,
  toolPaths: string[],
): string {
  if (!content?.trim()) return "";
  const blocks = splitGitDiffs(content);
  if (blocks.length > 0) {
    return blocks.find((block) => pathsMatch(block.path, path))?.diff ?? "";
  }

  // Legacy Grove output joined each ACP Diff with a blank separator after
  // stripping its file identity. Unified-diff bodies themselves start with a
  // hunk marker and never use a truly empty line between hunks (blank source
  // lines still carry the diff prefix), so an exact block-count match lets us
  // safely restore the original location order. Do not attempt this for old
  // code-fenced new-file payloads, whose contents can contain arbitrary blank
  // lines.
  const trimmed = content.trim();
  if (toolPaths.length > 1 && trimmed.startsWith("@@")) {
    const legacyBlocks = trimmed.split(/\n{2,}(?=@@\s)/);
    const pathIndex = toolPaths.findIndex((candidate) => pathsMatch(candidate, path));
    if (legacyBlocks.length === toolPaths.length && pathIndex >= 0) {
      return legacyBlocks[pathIndex] ?? "";
    }
  }

  // A headerless payload is otherwise safe only for a single target.
  return toolPaths.length === 1 ? content : "";
}
