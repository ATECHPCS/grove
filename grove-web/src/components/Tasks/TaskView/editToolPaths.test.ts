import { describe, expect, it } from "vitest";

import { extractDiffForEditPath, extractEditToolPaths } from "./editToolPaths";

describe("extractEditToolPaths", () => {
  it("prefers explicit ACP locations", () => {
    expect(extractEditToolPaths({
      locations: [{ path: "/repo/src/client.ts" }],
      rawInput: { file_path: "src/client.ts", path: "src/duplicate.ts" },
    })).toEqual(["/repo/src/client.ts"]);
  });

  it("extracts common edit-tool path fields", () => {
    expect(extractEditToolPaths({
      rawInput: {
        edits: [
          { file_path: "src/client.ts" },
          { path: "src/server.ts" },
        ],
      },
    })).toEqual(["src/client.ts", "src/server.ts"]);
  });

  it("extracts every file from an apply_patch request", () => {
    expect(extractEditToolPaths({
      rawInput: {
        patch: [
          "*** Begin Patch",
          "*** Update File: src/client.ts",
          "*** Add File: src/profile.ts",
          "*** End Patch",
        ].join("\n"),
      },
    })).toEqual(["src/client.ts", "src/profile.ts"]);
  });

  it("falls back to unified diff headers in tool output", () => {
    expect(extractEditToolPaths({
      content: "diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts",
    })).toEqual(["src/new.ts", "src/old.ts"]);
  });
});

describe("extractDiffForEditPath", () => {
  const multiFileDiff = [
    "diff --git a/repo/go.mod b/repo/go.mod",
    "--- a/repo/go.mod",
    "+++ b/repo/go.mod",
    "@@ -1 +1 @@",
    "-old module",
    "+new module",
    "diff --git a/repo/model/config.go b/repo/model/config.go",
    "--- a/repo/model/config.go",
    "+++ b/repo/model/config.go",
    "@@ -4 +4 @@",
    "-old config",
    "+new config",
  ].join("\n");

  it("returns only the matching file block from a multi-file diff", () => {
    expect(
      extractDiffForEditPath(multiFileDiff, "/repo/go.mod", [
        "/repo/go.mod",
        "/repo/model/config.go",
      ]),
    ).toContain("-old module");
    expect(
      extractDiffForEditPath(multiFileDiff, "/repo/go.mod", [
        "/repo/go.mod",
        "/repo/model/config.go",
      ]),
    ).not.toContain("old config");
  });

  it("does not attribute an unscoped aggregate diff to multiple files", () => {
    expect(
      extractDiffForEditPath("@@ -1 +1 @@\n-old\n+new", "/repo/go.mod", [
        "/repo/go.mod",
        "/repo/model/config.go",
      ]),
    ).toBe("");
  });

  it("restores legacy headerless diff blocks by exact location order", () => {
    const legacy = [
      "@@ -1 +1 @@\n-old module\n+new module",
      "@@ -4 +4 @@\n-old config\n+new config",
    ].join("\n\n");
    const paths = ["/repo/go.mod", "/repo/model/config.go"];

    expect(extractDiffForEditPath(legacy, paths[0], paths)).toContain(
      "+new module",
    );
    expect(extractDiffForEditPath(legacy, paths[1], paths)).toContain(
      "+new config",
    );
  });

  it("keeps a legacy unscoped diff when the tool targets one file", () => {
    expect(
      extractDiffForEditPath("@@ -1 +1 @@\n-old\n+new", "/repo/go.mod", [
        "/repo/go.mod",
      ]),
    ).toContain("+new");
  });
});
