// Pure projection of the chat `messages` array into the render-item list and
// the conversation-minimap turns. Extracted verbatim from TaskChat.tsx so this
// hot derivation path is unit-testable and benchmarkable in isolation (see
// taskChatRenderItems.test.ts). No behavior change from the inline versions.
//
// `buildRenderItems` walks `messages` turn-by-turn (a turn = a `user` message
// plus the assistant/tool material that follows it until the next `user`). Each
// completed turn's output depends only on that turn's own messages, so only the
// final, still-streaming turn is volatile — the property that makes windowing
// (and, later, incremental rebuild) safe.

import type { ChatMessage, ToolMessage } from "./chatMessageTypes";

export type ToolSectionItem = { message: ToolMessage; index: number };
export type WorkSummaryItem = {
  message: Extract<ChatMessage, { type: "assistant" | "thinking" | "tool" }>;
  index: number;
};
export type RenderItem =
  | { kind: "single"; message: ChatMessage; index: number }
  | { kind: "tool-section"; sectionId: string; tools: ToolSectionItem[] }
  | {
      kind: "work-summary";
      sectionId: string;
      items: WorkSummaryItem[];
      durationSeconds?: number;
    }
  | { kind: "file-change-summary"; sectionId: string; tools: ToolSectionItem[] };

export function renderItemKey(item: RenderItem): string {
  return item.kind === "single"
    ? `m-${item.index}`
    : item.kind === "tool-section"
      ? `ts-${item.sectionId}`
      : item.kind === "work-summary"
        ? `ws-${item.sectionId}`
        : `fs-${item.sectionId}`;
}

/** A user prompt and the assistant material that follows it.  This is a
 * presentation-only projection of `messages`: the full message history
 * remains the source of truth and no extra history is persisted. */
export type ConversationTurn = {
  messageIndex: number;
  renderIndex: number;
  user: string;
  assistant: string;
  isStreaming: boolean;
  tools: { label: string; count: number }[];
};

export function normalizeToolVerb(title: string): string {
  const lower = title.toLowerCase();
  if (lower.startsWith("read")) return "read";
  if (lower.startsWith("edit") || lower.startsWith("write")) return "edit";
  if (
    lower.startsWith("run") ||
    lower === "terminal" ||
    lower === "exec_command" ||
    lower === "write_stdin"
  )
    return "run";
  if (
    lower.startsWith("search") ||
    lower === "grep" ||
    lower.startsWith("find") ||
    lower === "glob" ||
    lower === "toolsearch"
  )
    return "search";
  if (lower.startsWith("list") || lower.startsWith("ls")) return "list";
  if (lower.startsWith("task") || lower.startsWith("update_plan"))
    return "plan";
  if (lower.includes("permission")) return "permission";
  return "other";
}

export function isEditTool(message: ToolMessage): boolean {
  return message.kind === "edit" || normalizeToolVerb(message.title) === "edit";
}

function conversationToolLabel(tool: ToolMessage): string {
  switch (normalizeToolVerb(tool.title)) {
    case "read":
    case "search":
    case "list":
    case "run":
      return "Exploration";
    case "edit":
      return "Edit";
    case "plan":
    case "permission":
    default:
      return "Action";
  }
}

export function compactConversationText(value: string, limit = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

/**
 * Builds the data for the chat's left-hand conversation minimap. Tool and
 * thinking events remain part of their surrounding user → assistant turn;
 * they do not create noisy standalone markers in the navigator.
 */
export function buildConversationTurns(
  messages: ChatMessage[],
  renderItems: RenderItem[],
): ConversationTurn[] {
  const renderIndexByMessageIndex = new Map<number, number>();
  renderItems.forEach((item, renderIndex) => {
    if (item.kind === "single") renderIndexByMessageIndex.set(item.index, renderIndex);
  });

  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;
  messages.forEach((message, messageIndex) => {
    if (message.type === "user") {
      const renderIndex = renderIndexByMessageIndex.get(messageIndex);
      if (renderIndex === undefined) return;
      current = {
        messageIndex,
        renderIndex,
        user: compactConversationText(message.content) || "Attachment",
        assistant: "",
        isStreaming: false,
        tools: [],
      };
      turns.push(current);
      return;
    }
    if (!current) return;
    if (message.type === "tool") {
      const label = conversationToolLabel(message);
      const existing = current.tools.find((tool) => tool.label === label);
      if (existing) existing.count += 1;
      else current.tools.push({ label, count: 1 });
      return;
    }
    if (message.type !== "assistant") return;
    const text = compactConversationText(message.content);
    if (text) current.assistant = compactConversationText(
      `${current.assistant}${current.assistant ? " " : ""}${text}`,
    );
    if (!message.complete) current.isStreaming = true;
  });
  return turns;
}

function buildSequentialRenderItems(
  messages: ChatMessage[],
  startIndex = 0,
): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ToolSectionItem[] = [];

  const flush = () => {
    if (toolBuf.length > 0) {
      items.push({
        kind: "tool-section",
        sectionId: toolBuf[0].message.id,
        tools: [...toolBuf],
      });
      toolBuf = [];
    }
  };

  messages.forEach((msg, offset) => {
    const i = startIndex + offset;
    if (msg.type === "thinking" && msg.complete) {
      // Keep completed reasoning in history but out of the transcript.
      flush();
    } else if (msg.type === "tool") {
      toolBuf.push({ message: msg, index: i });
    } else if (msg.type === "auth_required") {
      // 不进消息流 — 由 composer panel 统一渲染(同 PermissionRequest)。
      // 留在 messages 数组里只为方便用 useMemo 派生 activeAuthMessage。
      flush();
    } else {
      flush();
      items.push({ kind: "single", message: msg, index: i });
    }
  });
  flush();
  return items;
}

/**
 * Keep the live turn chronological, then compact completed turns in the same
 * way command-oriented agents do: everything through the final tool call is
 * one expandable work record, while the answer emitted after that boundary
 * remains fully visible.
 */
export function buildRenderItems(messages: ChatMessage[], isBusy = false): RenderItem[] {
  const items: RenderItem[] = [];
  let cursor = 0;

  while (cursor < messages.length) {
    let userIndex = cursor;
    while (userIndex < messages.length && messages[userIndex].type !== "user") {
      userIndex += 1;
    }
    if (userIndex >= messages.length) {
      items.push(...buildSequentialRenderItems(messages.slice(cursor), cursor));
      break;
    }

    items.push(...buildSequentialRenderItems(messages.slice(cursor, userIndex), cursor));
    items.push({ kind: "single", message: messages[userIndex], index: userIndex });

    let nextUserIndex = userIndex + 1;
    while (
      nextUserIndex < messages.length &&
      messages[nextUserIndex].type !== "user"
    ) {
      nextUserIndex += 1;
    }
    const isLatestTurn = nextUserIndex === messages.length;
    const turnEntries = messages.slice(userIndex + 1, nextUserIndex);
    const hasStreamingEntry = turnEntries.some(
      (message) =>
        (message.type === "assistant" || message.type === "thinking") &&
        !message.complete,
    );

    if ((isLatestTurn && isBusy) || hasStreamingEntry) {
      items.push(
        ...buildSequentialRenderItems(turnEntries, userIndex + 1),
      );
      cursor = nextUserIndex;
      continue;
    }

    // Rich ACP content must retain its exact position relative to text and
    // tools. The compact WorkSummary intentionally rearranges process items,
    // so keep these uncommon turns in the sequential renderer.
    const hasStructuredAssistantContent = turnEntries.some(
      (message) =>
        message.type === "assistant" &&
        message.blocks?.some((block) => block.type !== "text"),
    );
    if (hasStructuredAssistantContent) {
      items.push(...buildSequentialRenderItems(turnEntries, userIndex + 1));
      cursor = nextUserIndex;
      continue;
    }

    let processEndOffset = -1;
    for (let i = turnEntries.length - 1; i >= 0; i -= 1) {
      if (turnEntries[i].type === "tool") {
        processEndOffset = i;
        break;
      }
    }
    // The turn's closing reply is normally the assistant text that trails the
    // last tool, and the block below renders everything after processEndOffset
    // sequentially. But when the agent's *last* recorded event is a tool call
    // (e.g. a bookkeeping TodoWrite fired after the summary, or the final text
    // chunk landed at/before that tool), the real reply sits at or before
    // processEndOffset and would be swallowed into the collapsed WorkSummary —
    // leaving only a "Worked" chip with no visible answer. Find that trailing
    // reply and lift it out so the conclusion is always shown as a bubble.
    let conclusionOffset = -1;
    let conclusionText = "";
    for (let i = turnEntries.length - 1; i >= 0; i -= 1) {
      const message = turnEntries[i];
      if (message.type === "assistant") {
        conclusionOffset = i;
        conclusionText = message.content ?? "";
        break;
      }
    }
    const liftConclusion =
      conclusionOffset >= 0 &&
      conclusionOffset <= processEndOffset &&
      conclusionText.trim().length > 0;
    if (processEndOffset >= 0) {
      const processItems: WorkSummaryItem[] = [];
      for (let i = 0; i < turnEntries.length; i += 1) {
        const message = turnEntries[i];
        if (liftConclusion && i === conclusionOffset) continue;
        if (
          (message.type === "assistant" && i <= processEndOffset) ||
          message.type === "thinking" ||
          message.type === "tool"
        ) {
          processItems.push({ message, index: userIndex + 1 + i });
        }
      }
      if (processItems.length > 0) {
        const timedAssistants = turnEntries.filter(
          (message): message is Extract<ChatMessage, { type: "assistant" }> =>
            message.type === "assistant",
        );
        const starts = timedAssistants
          .map((message) => message.startTs)
          .filter((value): value is number => typeof value === "number");
        const ends = timedAssistants
          .map((message) => message.endTs)
          .filter((value): value is number => typeof value === "number");
        items.push({
          kind: "work-summary",
          sectionId: `work-${userIndex}-${processItems.at(-1)!.index}`,
          items: processItems,
          durationSeconds:
            starts.length > 0 && ends.length > 0
              ? Math.max(0, Math.max(...ends) - Math.min(...starts))
              : undefined,
        });
      }
      // Preserve uncommon inline messages (permission/system/etc.) that are
      // not part of the compactable agent process.
      const passthrough = turnEntries
        .slice(0, processEndOffset + 1)
        .map((message, offset) => ({ message, index: userIndex + 1 + offset }))
        .filter(
          ({ message }) =>
            message.type !== "assistant" &&
            message.type !== "thinking" &&
            message.type !== "tool",
        );
      passthrough.forEach(({ message, index }) =>
        items.push({ kind: "single", message, index }),
      );
      const trailingStart = userIndex + processEndOffset + 2;
      items.push(
        ...buildSequentialRenderItems(
          turnEntries.slice(processEndOffset + 1),
          trailingStart,
        ).filter(
          (item) =>
            item.kind !== "single" || item.message.type !== "thinking",
        ),
      );
      if (liftConclusion) {
        items.push({
          kind: "single",
          message: turnEntries[conclusionOffset],
          index: userIndex + 1 + conclusionOffset,
        });
      }
      const editedTools = processItems.flatMap(({ message, index }) =>
        message.type === "tool" && isEditTool(message)
          ? [{ message, index }]
          : [],
      );
      if (editedTools.length > 0) {
        items.push({
          kind: "file-change-summary",
          sectionId: `files-${userIndex}`,
          tools: editedTools,
        });
      }
    } else {
      items.push(...buildSequentialRenderItems(turnEntries, userIndex + 1));
    }
    cursor = nextUserIndex;
  }
  return items;
}
