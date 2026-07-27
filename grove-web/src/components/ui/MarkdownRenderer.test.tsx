import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownRenderer file resources", () => {
  it("routes a relative iframe src through the worktree raw endpoint", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={'<iframe src="../../internal/diagram.html" title="diagram"></iframe>'}
        location={{
          projectId: "project",
          root: { kind: "task", taskId: "task" },
          path: "output/deliverables/section.md",
        }}
      />,
    );

    expect(html).toContain(
      'src="/api/v1/projects/project/tasks/task/files/raw?path=internal%2Fdiagram.html"',
    );
  });

  it("routes an iframe outside the git root through the unrestricted raw endpoint", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={'<iframe src="../../internal/diagram.html"></iframe>'}
        location={{
          projectId: "project",
          root: { kind: "task", taskId: "_local" },
          path: "section.md",
        }}
      />,
    );

    expect(html).toContain(
      'src="/api/v1/projects/project/tasks/_local/files/raw?path=..%2F..%2Finternal%2Fdiagram.html"',
    );
  });

  it("renders an error instead of the Grove page for an empty iframe src", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer content={'<iframe src=""></iframe>'} />,
    );

    expect(html).toContain("Embedded resource unavailable");
    expect(html).not.toContain("<iframe");
  });

  it("renders an error for a relative iframe without a file location", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer content={'<iframe src="diagram.html"></iframe>'} />,
    );

    expect(html).toContain("Embedded resource unavailable");
    expect(html).not.toContain("<iframe");
  });
});

describe("MarkdownRenderer emphasis", () => {
  it("renders CJK labels ending in a full-width colon as strong text", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer content={'- **商家上下文分散：**集成方案'} />,
    );

    expect(html).toContain("<strong");
    expect(html).toContain("商家上下文分散：</strong>集成方案");
    expect(html).not.toContain("**商家上下文分散");
  });
});

describe("MarkdownRenderer lists", () => {
  it("keeps loose-list markers on the same line as the first paragraph", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer
        content={'- **Workflow：**需求分析\n\n- **Skill 与工具：**分享 CLI'}
      />,
    );

    expect(html).toContain("[li&gt;&amp;:first-child]:inline");
    expect(html).toContain("<li");
    expect(html).toContain("<p");
  });
});

describe("MarkdownRenderer streaming reconciliation", () => {
  it("preserves completed rich nodes when later text is appended", () => {
    const stableContent = [
      "![diagram](https://example.com/diagram.png)",
      "",
      "```ts",
      "const stable = true;",
      "```",
    ].join("\n");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<MarkdownRenderer content={stableContent} />));
    const image = container.querySelector("img");
    const codeBlock = container.querySelector(".markdown-code-block");

    expect(image).not.toBeNull();
    expect(codeBlock).not.toBeNull();

    act(() =>
      root.render(
        <MarkdownRenderer
          content={`${stableContent}\n\nThe response keeps streaming after the rich blocks.`}
        />,
      ),
    );

    expect(container.querySelector("img")).toBe(image);
    expect(container.querySelector(".markdown-code-block")).toBe(codeBlock);

    act(() => root.unmount());
    container.remove();
  });
});
