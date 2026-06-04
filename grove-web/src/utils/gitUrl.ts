// Shared git-URL smart parsing — used by both the Skills "Add Source" dialog
// and the Plugins "Add Plugin" (From Git) dialog so the two stay consistent.

/** Derive a short name from a git URL / path (last meaningful path segment). */
export function extractNameFromUrl(url: string): string {
  let cleaned = url.trim();
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const parsed = parseGitInput(cleaned);
      if (parsed.url) {
        cleaned = parsed.url;
      }
    } catch {
      // ignore and use raw
    }
  }
  // Remove trailing slashes and any trailing .git (including multiple .git)
  cleaned = cleaned.replace(/\/+$/, "").replace(/(?:\.git)+$/i, "");
  // Split on delimiters (including ? and # to strip queries/fragments)
  const segments = cleaned.split(/[/:\\?#]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

// Smart-parse a user-pasted string into a canonical git URL (+ optional subpath).
// Handles:
//   - Standard https://github.com/<owner>/<repo>(.git)?
//   - SSH git@github.com:<owner>/<repo>(.git)?
//   - Bare shortcut <owner>/<repo>  →  https://github.com/<owner>/<repo>.git
//   - GitHub tree/blob URLs        →  base repo URL + subpath
//   - CLI-style "npx skills add <repo> [flags]" / "skills add <repo>"
export function parseGitInput(raw: string): { url: string; subpath?: string } {
  let input = raw.trim();
  if (!input) return { url: "" };
  // Cap input length — the parsers below are cheap, but pathologically long
  // strings are almost never a legitimate git URL and could exercise
  // worst-case regex behaviour. Cheap to reject.
  if (input.length > 2000) return { url: "" };

  // Strip CLI command prefixes: "npx skills add X -y -g" → "X"
  const cliMatch = input.match(/^(?:npx\s+)?skills\s+add\s+(.+)$/i);
  if (cliMatch) {
    const tokens = cliMatch[1].split(/\s+/).filter((t) => t && !t.startsWith("-"));
    if (tokens.length > 0) input = tokens[0];
  }

  // HTTP/HTTPS URLs
  if (/^https?:\/\//i.test(input)) {
    try {
      const urlObj = new URL(input);
      let pathname = urlObj.pathname;

      // Look for web UI markers to split the repo URL and extract optional subpath.
      // Matches standard paths like tree, blob, pulls, issues, merge_requests, etc.
      const markerMatch = pathname.match(
        /\/(?:-\/)?(?:tree|blob|pulls|pull|issues|issue|merge_requests|actions|projects|wiki|releases|tags|commits|commit|branches|milestones|settings)(?:\/|$)/i
      );

      let subpath: string | undefined;

      if (markerMatch && markerMatch.index !== undefined && markerMatch.index > 0) {
        const repoPathname = pathname.slice(0, markerMatch.index);
        const marker = markerMatch[0];

        // Extract subpath only for tree/blob markers
        if (/\/tree\//i.test(marker) || /\/blob\//i.test(marker)) {
          const remaining = pathname.slice(markerMatch.index + marker.length);
          const parts = remaining.split("/").filter(Boolean);
          if (parts.length > 1) {
            subpath = parts.slice(1).join("/");
          }
        }

        pathname = repoPathname;
      }

      // Clean up trailing slash and any trailing .git (handling duplicate .git too)
      const cleanPathname = pathname.replace(/\/+$/, "").replace(/(?:\.git)+$/i, "");

      if (cleanPathname && cleanPathname !== "/") {
        urlObj.pathname = cleanPathname + ".git";
      } else {
        urlObj.pathname = cleanPathname;
      }

      // Clear out query parameters and hashes from the repository URL
      urlObj.search = "";
      urlObj.hash = "";

      return {
        url: urlObj.toString(),
        subpath: subpath || undefined,
      };
    } catch {
      // Fallback if URL parsing fails
    }
  }

  // SSH form — leave as-is (already canonical, but clean up duplicate .git)
  if (/^git@[^:]+:[^/]+\/.+/.test(input)) {
    const cleanedSsh = input.replace(/\/+$/, "").replace(/(?:\.git)+$/i, "");
    return { url: `${cleanedSsh}.git` };
  }

  // Bare owner/repo shortcut
  const shortMatch = input.match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\.git)?$/);
  if (shortMatch) {
    return { url: `https://github.com/${shortMatch[1]}/${shortMatch[2]}.git` };
  }

  return { url: input };
}
