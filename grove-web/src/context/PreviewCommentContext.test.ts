import { describe, expect, it } from "vitest";
import type { PreviewCommentDraft } from "./PreviewCommentContext";
import { previewCommentTaskLabel } from "./previewCommentUtils";

function draft(id: string, projectId: string, taskId: string): PreviewCommentDraft {
  return {
    id,
    source: "chat",
    projectId,
    taskId,
    filePath: `chat/${id}`,
    fileName: id,
    rendererId: "markdown",
    locator: { type: "dom", selector: "p", tagName: "p" },
    comment: id,
    createdAt: 1,
  };
}

describe("previewCommentTaskLabel", () => {
  it("numbers comments within the current task instead of provider-wide", () => {
    const drafts = [
      draft("other-project", "project-2", "task-1"),
      draft("other-task", "project-1", "task-2"),
      draft("first", "project-1", "task-1"),
      draft("second", "project-1", "task-1"),
      draft("third", "project-1", "task-1"),
    ];

    expect(previewCommentTaskLabel(drafts, drafts[2])).toBe("1");
    expect(previewCommentTaskLabel(drafts, drafts[3])).toBe("2");
    expect(previewCommentTaskLabel(drafts, drafts[4])).toBe("3");
  });
});
