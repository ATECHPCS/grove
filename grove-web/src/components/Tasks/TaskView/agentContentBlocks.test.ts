import { describe, expect, it } from "vitest";
import {
  appendStructuredContentBlock,
  appendTextContentBlock,
  type AgentContentBlock,
} from "./agentContentBlocks";

describe("ordered agent content blocks", () => {
  it("merges adjacent text chunks", () => {
    expect(appendTextContentBlock(undefined, "hello", " world")).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("preserves text and structured content arrival order", () => {
    const image = {
      type: "image",
      data: "base64-image",
      mime_type: "image/png",
    } satisfies AgentContentBlock;
    let blocks = appendTextContentBlock(undefined, "", "before");
    blocks = appendStructuredContentBlock(blocks, "", image);
    blocks = appendTextContentBlock(blocks, "", "after");

    expect(blocks).toEqual([
      { type: "text", text: "before" },
      image,
      { type: "text", text: "after" },
    ]);
  });

  it("keeps legacy assistant text when the first rich block arrives", () => {
    const blocks = appendStructuredContentBlock(undefined, "legacy text", {
      type: "resource_link",
      uri: "file:///tmp/report.md",
      name: "report.md",
    });

    expect(blocks).toEqual([
      { type: "text", text: "legacy text" },
      {
        type: "resource_link",
        uri: "file:///tmp/report.md",
        name: "report.md",
      },
    ]);
  });
});
