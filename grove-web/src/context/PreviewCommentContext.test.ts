import { describe, expect, it } from "vitest";
import type { PreviewCommentDraft } from "./PreviewCommentContext";
import {
  previewCommentLocatorInParentViewport,
  previewCommentTaskLabel,
} from "./previewCommentUtils";

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

describe("previewCommentLocatorInParentViewport", () => {
  it("translates iframe-local rectangles for parent-document portals", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    frame.getBoundingClientRect = () => ({
      left: 120,
      top: 80,
      right: 620,
      bottom: 480,
      width: 500,
      height: 400,
      x: 120,
      y: 80,
      toJSON: () => ({}),
    });
    const locator = {
      type: "dom" as const,
      selector: "h2",
      tagName: "h2",
      rect: { x: 25, y: 35, width: 200, height: 40 },
    };

    expect(previewCommentLocatorInParentViewport(locator, frame.contentWindow, document).rect).toEqual({
      x: 145,
      y: 115,
      width: 200,
      height: 40,
    });
    frame.remove();
  });

  it("keeps parent-DOM coordinates unchanged", () => {
    const locator = {
      type: "dom" as const,
      selector: "p",
      tagName: "p",
      rect: { x: 10, y: 20, width: 30, height: 40 },
    };

    expect(previewCommentLocatorInParentViewport(locator, window, document)).toBe(locator);
  });
});
