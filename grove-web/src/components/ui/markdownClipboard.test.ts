import { describe, expect, it } from "vitest";
import { selectedMarkdownForRange } from "./markdownClipboard";

function markdownRoot() {
  const root = document.createElement("div");
  root.innerHTML = '<p data-grove-markdown-source="**Complete paragraph**">Complete paragraph</p>';
  document.body.appendChild(root);
  return root;
}

describe("selectedMarkdownForRange", () => {
  it("does not expand a partial text selection to the complete Markdown block", () => {
    const root = markdownRoot();
    const text = root.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);

    expect(selectedMarkdownForRange(root, range)).toBeNull();
    root.remove();
  });

  it("returns Markdown source when the complete block is selected", () => {
    const root = markdownRoot();
    const paragraph = root.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);

    expect(selectedMarkdownForRange(root, range)).toBe("**Complete paragraph**");
    root.remove();
  });
});
