import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getPreviewRenderer } from "../Review/previewRenderers";
import {
  FullFilePreview,
} from "./FullFilePreview";
import {
  LARGE_MARKDOWN_PREVIEW_THRESHOLD,
  isVirtualizedMarkdownPreview,
} from "./filePreviewPolicy";

describe("FullFilePreview", () => {
  it("keeps the large-markdown threshold in one shared policy", () => {
    expect(isVirtualizedMarkdownPreview(
      "design.md",
      "x".repeat(LARGE_MARKDOWN_PREVIEW_THRESHOLD),
    )).toBe(false);
    expect(isVirtualizedMarkdownPreview(
      "design.MARKDOWN",
      "x".repeat(LARGE_MARKDOWN_PREVIEW_THRESHOLD + 1),
    )).toBe(true);
    expect(isVirtualizedMarkdownPreview(
      "design.txt",
      "x".repeat(LARGE_MARKDOWN_PREVIEW_THRESHOLD + 1),
    )).toBe(false);
  });

  it("owns the ordinary full-file renderer layout", () => {
    const html = renderToStaticMarkup(
      <FullFilePreview fileName="notes.md" content="# Notes" />,
    );

    expect(html).toContain('data-file-preview-renderer="markdown"');
    expect(html).toContain('data-file-preview-virtualized="false"');
    expect(html).toContain("p-5");
  });

  it("keeps the virtualized markdown viewport height through the comment host", () => {
    const html = renderToStaticMarkup(
      <FullFilePreview
        fileName="large.md"
        content={`# Large\n\n${"body\n\n".repeat(6_000)}`}
        previewComment={{ previewId: "large-preview" }}
      />,
    );

    expect(html).toContain('data-file-preview-virtualized="true"');
    expect(html.match(/h-full min-h-0/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("marks bounded renderers as fill-layout capabilities", () => {
    expect(getPreviewRenderer("diagram.png", "full")?.layout).toBe("fill");
    expect(getPreviewRenderer("report.xlsx", "full")?.layout).toBe("fill");
    expect(getPreviewRenderer("notes.md", "full")?.layout).toBe("document");
  });
});
