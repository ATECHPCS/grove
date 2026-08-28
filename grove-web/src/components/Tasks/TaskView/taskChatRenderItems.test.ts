import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolMessage } from "./chatMessageTypes";
import {
  buildConversationTurns,
  buildRenderItems,
  normalizeToolVerb,
  renderItemKey,
} from "./taskChatRenderItems";

// ── Synthetic message builders ───────────────────────────────────────────────

function user(content: string): ChatMessage {
  return { type: "user", content };
}
function assistant(content: string, complete = true): ChatMessage {
  return { type: "assistant", content, complete };
}
function tool(id: string, title: string): ToolMessage {
  return { type: "tool", id, title, status: "completed", collapsed: false };
}

/** A completed turn: prompt → two tool calls → a trailing reply. Exercises the
 *  WorkSummary compaction + conclusion-lift path in buildRenderItems. */
function completedTurn(n: number): ChatMessage[] {
  return [
    user(`question ${n}`),
    tool(`t${n}a`, "Read file.ts"),
    tool(`t${n}b`, "Edit file.ts"),
    assistant(`answer ${n}`),
  ];
}

function chatOf(turns: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < turns; i += 1) msgs.push(...completedTurn(i));
  return msgs;
}

// ── Behavior lock (golden) ───────────────────────────────────────────────────
// These pin the projection so the render-window change (which only slices the
// `messages` array fed in) can be shown not to alter per-turn output.

describe("buildRenderItems", () => {
  it("compacts a completed tool turn into a work-summary + lifted reply", () => {
    const msgs = completedTurn(0);
    const items = buildRenderItems(msgs, false);
    const kinds = items.map((i) => i.kind);
    // user bubble, then the collapsed work record, a file-change summary, and
    // the trailing answer bubble (order: single(user) → work-summary → single(reply) → file-change-summary).
    expect(kinds[0]).toBe("single");
    expect(kinds).toContain("work-summary");
    expect(kinds).toContain("file-change-summary");
    // the answer text survives as a visible single bubble
    const replies = items.filter(
      (i) => i.kind === "single" && i.message.type === "assistant",
    );
    expect(replies).toHaveLength(1);
    expect(
      replies[0].kind === "single" && replies[0].message.type === "assistant"
        ? replies[0].message.content
        : null,
    ).toBe("answer 0");
  });

  it("keeps a streaming turn sequential (no work-summary compaction)", () => {
    const msgs: ChatMessage[] = [
      user("q"),
      tool("t", "Read x"),
      assistant("partial", false),
    ];
    const items = buildRenderItems(msgs, true);
    expect(items.some((i) => i.kind === "work-summary")).toBe(false);
    // streaming assistant is rendered live as its own single bubble
    expect(
      items.some((i) => i.kind === "single" && i.message.type === "assistant"),
    ).toBe(true);
  });

  it("lifts the conclusion when the last event is a tool call", () => {
    const msgs: ChatMessage[] = [
      user("q"),
      assistant("here is the answer"),
      tool("t", "TodoWrite"),
    ];
    const items = buildRenderItems(msgs, false);
    // the reply must remain visible as a single bubble, not be swallowed
    const reply = items.find(
      (i) => i.kind === "single" && i.message.type === "assistant",
    );
    expect(reply).toBeDefined();
  });

  it("projects independently per turn (slicing off older turns preserves the tail)", () => {
    // The windowing fix relies on this: buildRenderItems over the last K turns
    // must equal the tail of buildRenderItems over the full history, because
    // completed turns are self-contained.
    const full = chatOf(8);
    const lastThreeStart = full.length - 3 * 4; // 3 turns × 4 msgs
    const windowed = full.slice(lastThreeStart);
    const windowedItems = buildRenderItems(windowed, false).map((i) => i.kind);
    const fullItems = buildRenderItems(full, false);
    const fullTailKinds = fullItems
      .slice(fullItems.length - windowedItems.length)
      .map((i) => i.kind);
    expect(windowedItems).toEqual(fullTailKinds);
  });
});

describe("buildConversationTurns", () => {
  it("yields one turn per user prompt with aggregated tool labels", () => {
    const msgs = completedTurn(0);
    const turns = buildConversationTurns(msgs, buildRenderItems(msgs, false));
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toBe("question 0");
    expect(turns[0].assistant).toContain("answer 0");
    // Read → Exploration, Edit → Edit
    const labels = turns[0].tools.map((t) => t.label).sort();
    expect(labels).toEqual(["Edit", "Exploration"]);
  });

  it("flags a streaming turn", () => {
    const msgs: ChatMessage[] = [user("q"), assistant("partial", false)];
    const turns = buildConversationTurns(msgs, buildRenderItems(msgs, true));
    expect(turns[0].isStreaming).toBe(true);
  });
});

describe("renderItemKey / normalizeToolVerb", () => {
  it("keys single items by message index and sections by id", () => {
    expect(renderItemKey({ kind: "single", message: user("x"), index: 7 })).toBe(
      "m-7",
    );
    expect(
      renderItemKey({ kind: "tool-section", sectionId: "abc", tools: [] }),
    ).toBe("ts-abc");
  });

  it("classifies common tool verbs", () => {
    expect(normalizeToolVerb("Read file")).toBe("read");
    expect(normalizeToolVerb("Edit file")).toBe("edit");
    expect(normalizeToolVerb("grep")).toBe("search");
    expect(normalizeToolVerb("run npm test")).toBe("run");
    expect(normalizeToolVerb("Bash run")).toBe("other");
  });
});

// ── Measurement: the O(total) per-build / O(n²)-while-streaming cost ─────────
// Not a pass/fail perf gate (timings are machine-dependent). It documents why
// tranche-2 bounds the derivation input with a render window: a full rebuild is
// linear in total history, and the chat rebuilds it on every streamed token, so
// a streaming turn costs O(history × tokens). Run with:
//   npx vitest run taskChatRenderItems --reporter=verbose   (see console table)

describe("derivation cost profile", () => {
  it("builds correctly at scale and reports the cost curve", () => {
    const sizes = [50, 200, 800, 2000];
    const rows: string[] = [];
    for (const turns of sizes) {
      const msgs = chatOf(turns);
      const REPS = 20;
      const t0 = performance.now();
      let items = buildRenderItems(msgs, false);
      for (let r = 1; r < REPS; r += 1) items = buildRenderItems(msgs, false);
      const perBuild = (performance.now() - t0) / REPS;

      // correctness at scale: one work-summary + one reply bubble per turn
      const replies = items.filter(
        (i) => i.kind === "single" && i.message.type === "assistant",
      ).length;
      expect(replies).toBe(turns);

      // streaming replay: rebuild once per token as the last turn grows.
      const TOKENS = 40;
      const base = msgs.slice();
      const ts0 = performance.now();
      for (let k = 0; k < TOKENS; k += 1) {
        const streaming = base.concat([
          user("live"),
          assistant("x".repeat(k + 1), false),
        ]);
        buildRenderItems(streaming, true);
      }
      const streamMs = performance.now() - ts0;

      rows.push(
        `${String(turns).padStart(5)} turns (${String(msgs.length).padStart(5)} msgs)` +
          `  build=${perBuild.toFixed(3)}ms  streamReplay(40tok)=${streamMs.toFixed(1)}ms`,
      );
    }
    console.log("\nderivation cost profile:\n" + rows.join("\n") + "\n");
    expect(rows).toHaveLength(sizes.length);
  });
});
