import { describe, expect, it } from "vitest";

import { collectReadMemoryIds } from "./memoryRead";
import type { ToolCallMessage } from "./toolCallReducer";

function tool(overrides: Partial<ToolCallMessage>): ToolCallMessage {
  return {
    type: "tool",
    id: "tool",
    title: "mcp.grove_agent.memory_read",
    status: "completed",
    collapsed: true,
    input: [
      { label: "Server", value: "grove_agent" },
      { label: "Tool", value: "memory_read" },
      { label: "Parameters · Entity Id", value: "memory-1" },
    ],
    output: [{
      type: "content",
      content: {
        type: "text",
        text: JSON.stringify({
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({ title: "Working agreement", content: "# Full memory\nBody" }),
            }],
          },
        }),
      },
    }],
    ...overrides,
  };
}

describe("collectReadMemoryIds", () => {
  it("collects completed memory_read results and keeps their entity ids", () => {
    expect(collectReadMemoryIds([
      { type: "user" },
      tool({}),
    ])).toEqual(["memory-1"]);
  });

  it("does not treat memory_recall as a read", () => {
    expect(collectReadMemoryIds([
      { type: "user" },
      tool({
        title: "mcp.grove_agent.memory_recall",
        input: [{ label: "Tool", value: "memory_recall" }],
      }),
    ])).toEqual([]);
  });

  it("keeps reads from earlier user turns", () => {
    expect(collectReadMemoryIds([
      { type: "user" },
      tool({}),
      { type: "user" },
    ])).toEqual(["memory-1"]);
  });

  it("does not depend on persisted output being parseable", () => {
    expect(collectReadMemoryIds([
      { type: "user" },
      tool({
        output: [{
          type: "content",
          content: { type: "text", text: '{"result":{"content":[...[truncated]' },
        }],
      }),
    ])).toEqual(["memory-1"]);
  });

  it("ignores a malformed read without an Entity ID", () => {
    expect(collectReadMemoryIds([
      { type: "user" },
      tool({ input: [{ label: "Tool", value: "memory_read" }] }),
    ])).toEqual([]);
  });
});
