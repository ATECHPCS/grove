import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolMessage } from "./chatMessageTypes";
import {
  buildConversationTurns,
  buildRenderItems,
  buildRenderItemsIncremental,
  createRenderItemsCache,
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

// ── Incremental derivation ≡ batch ──────────────────────────────────────────
// buildRenderItemsIncremental must return a result byte-identical to
// buildRenderItems at every step of a realistic stream evolution, while only
// rebuilding the streaming turn. Unchanged messages MUST keep their object
// identity across steps (as React does when it setMessages new refs only for
// changed messages) — that identity is what the incremental reuse check reads.

describe("buildRenderItemsIncremental", () => {
  const expectMatches = (msgs: ChatMessage[], isBusy: boolean, cache = createRenderItemsCache()) => {
    const inc = buildRenderItemsIncremental(msgs, isBusy, cache);
    expect(inc).toEqual(buildRenderItems(msgs, isBusy));
    return cache;
  };

  it("matches batch while streaming tokens onto the last turn", () => {
    const cache = createRenderItemsCache();
    const prior = chatOf(30); // 30 completed turns, ref-stable across steps
    const userMsg = user("live question");
    for (let k = 1; k <= 25; k += 1) {
      // new array each token; prior turns + user keep identity, only the
      // streaming assistant is a fresh object (as a token append would be).
      const msgs = prior.concat([userMsg, assistant("x".repeat(k), false)]);
      expectMatches(msgs, true, cache);
    }
  });

  it("matches batch across turn completion + a new turn starting", () => {
    const cache = createRenderItemsCache();
    const base = chatOf(5);
    const u1 = user("q6");
    // stream, then complete (adds a trailing tool → compaction/lift path)
    expectMatches(base.concat([u1, assistant("partial", false)]), true, cache);
    const completed = base.concat([u1, assistant("done", true), tool("t6", "Edit a")]);
    expectMatches(completed, false, cache);
    // new turn begins — the just-finished turn moves into the reusable prefix
    const u2 = user("q7");
    expectMatches(completed.concat([u2, assistant("next", false)]), true, cache);
  });

  it("falls back correctly when the front is pruned (index shift)", () => {
    const cache = createRenderItemsCache();
    const full = chatOf(20);
    expectMatches(full, false, cache);
    // simulate pruneChatViewMessages slicing the oldest 8 messages off the front
    const pruned = full.slice(8);
    expectMatches(pruned, false, cache); // prefix refs differ → full rebuild, still equal
    // continue streaming after the prune
    const u = user("post-prune");
    expectMatches(pruned.concat([u, assistant("y", false)]), true, cache);
  });

  it("is idempotent under repeated identical calls (StrictMode double-invoke)", () => {
    const cache = createRenderItemsCache();
    const msgs = chatOf(10).concat([user("live"), assistant("streaming", false)]);
    const a = buildRenderItemsIncremental(msgs, true, cache);
    const b = buildRenderItemsIncremental(msgs, true, cache);
    const c = buildRenderItemsIncremental(msgs, true, cache);
    expect(a).toEqual(buildRenderItems(msgs, true));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("tracks a randomized append/stream/complete/prune sequence (seeded)", () => {
    // Deterministic LCG so a failure reproduces.
    let seed = 0x2545f491;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const cache = createRenderItemsCache();
    let msgs: ChatMessage[] = [];
    let streaming = false;
    let turnNo = 0;
    for (let step = 0; step < 400; step += 1) {
      const r = rnd();
      if (!streaming && r < 0.25) {
        // start a turn
        turnNo += 1;
        msgs = msgs.concat([user(`q${turnNo}`), assistant("", false)]);
        streaming = true;
      } else if (streaming && r < 0.55) {
        // stream a token (replace last assistant with a longer, fresh object)
        const last = msgs[msgs.length - 1];
        const grown =
          last.type === "assistant"
            ? assistant((last.content ?? "") + "z", false)
            : last;
        msgs = msgs.slice(0, -1).concat([grown]);
      } else if (streaming && r < 0.72) {
        // interleave a tool call mid-turn
        msgs = msgs.concat([tool(`t${turnNo}-${step}`, r < 0.6 ? "Read f" : "Edit f")]);
      } else if (streaming && r < 0.9) {
        // complete the turn
        msgs = msgs.slice(0, -1).concat([assistant(`answer ${turnNo}`, true)]);
        if (rnd() < 0.4) msgs = msgs.concat([tool(`tc${turnNo}`, "TodoWrite")]);
        streaming = false;
      } else if (!streaming && msgs.length > 40 && r < 0.97) {
        // prune the oldest few (front-slice, index shift)
        msgs = msgs.slice(3 + Math.floor(rnd() * 5));
      }
      const inc = buildRenderItemsIncremental(msgs, streaming, cache);
      expect(inc).toEqual(buildRenderItems(msgs, streaming));
    }
    expect(turnNo).toBeGreaterThan(5); // exercised real evolution
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

  it("incremental streaming cost is flat vs. batch's O(history)", () => {
    const rows: string[] = [];
    for (const turns of [200, 800, 2000]) {
      const prior = chatOf(turns);
      const u = user("live");
      const TOKENS = 60;

      // batch: rebuild whole history every token
      const b0 = performance.now();
      for (let k = 1; k <= TOKENS; k += 1) {
        buildRenderItems(prior.concat([u, assistant("z".repeat(k), false)]), true);
      }
      const batchMs = performance.now() - b0;

      // incremental: reuse the `turns` completed turns, rebuild only the live one
      const cache = createRenderItemsCache();
      const i0 = performance.now();
      for (let k = 1; k <= TOKENS; k += 1) {
        buildRenderItemsIncremental(
          prior.concat([u, assistant("z".repeat(k), false)]),
          true,
          cache,
        );
      }
      const incMs = performance.now() - i0;

      rows.push(
        `${String(turns).padStart(5)} prior turns  batch=${batchMs.toFixed(1)}ms  incremental=${incMs.toFixed(1)}ms  (${(batchMs / incMs).toFixed(1)}× faster)`,
      );
    }
    console.log("\nstreaming 60 tokens — batch vs incremental:\n" + rows.join("\n") + "\n");
    expect(rows).toHaveLength(3);
  });
});
