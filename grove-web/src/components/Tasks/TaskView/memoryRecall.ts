import type { ToolCallMessage } from "./toolCallReducer";

export interface RecalledMemory {
  entityId?: string;
  title: string;
  description: string;
  tags: string[];
}

type RecallPayload = {
  items?: unknown;
  result?: unknown;
  content?: unknown;
  text?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryRecallTool(message: ToolCallMessage): boolean {
  const toolName = message.input
    ?.find((field) => field.label.trim().toLowerCase() === "tool")
    ?.value.trim()
    .toLowerCase();
  return (
    toolName === "memory_recall" ||
    /(?:^|[/\s:])memory_recall$/i.test(message.title.trim())
  );
}

function parseMemoryItem(value: unknown): RecalledMemory | null {
  if (
    !isRecord(value) ||
    typeof value.title !== "string" ||
    !value.title.trim()
  ) {
    return null;
  }
  return {
    entityId:
      typeof value.entity_id === "string" && value.entity_id.trim()
        ? value.entity_id.trim()
        : undefined,
    title: value.title.trim(),
    description:
      typeof value.description === "string" ? value.description.trim() : "",
    tags: Array.isArray(value.tags)
      ? value.tags.filter(
          (tag): tag is string => typeof tag === "string" && !!tag.trim(),
        )
      : [],
  };
}

function memoriesFromPayload(payload: unknown): RecalledMemory[] {
  if (typeof payload === "string") {
    try {
      return memoriesFromPayload(JSON.parse(payload));
    } catch {
      return [];
    }
  }
  if (Array.isArray(payload)) {
    return payload.flatMap(memoriesFromPayload);
  }
  if (!isRecord(payload)) return [];

  const value = payload as RecallPayload;
  if (Array.isArray(value.items)) {
    return value.items.flatMap((item) => {
      const memory = parseMemoryItem(item);
      return memory ? [memory] : [];
    });
  }

  return [value.result, value.content, value.text].flatMap(memoriesFromPayload);
}

function memoriesFromTool(message: ToolCallMessage): RecalledMemory[] {
  const textBlocks = (message.output ?? []).flatMap((item): string[] => {
    if (item.type !== "content" || item.content.type !== "text") return [];
    return item.content.text ? [item.content.text] : [];
  });
  if (textBlocks.length === 0 && message.content) textBlocks.push(message.content);
  return textBlocks.flatMap(memoriesFromPayload);
}

/** Collect the successful memory_recall results in the current user turn. */
export function collectCurrentTurnRecalledMemories(
  messages: readonly { type: string }[],
): RecalledMemory[] {
  let turnStart = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].type === "user") {
      turnStart = i;
      break;
    }
  }

  const recalled = new Map<string, RecalledMemory>();
  for (let i = turnStart + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.type !== "tool") continue;
    const tool = message as ToolCallMessage;
    if (!isMemoryRecallTool(tool) || tool.status !== "completed") continue;
    for (const memory of memoriesFromTool(tool)) {
      const key = memory.entityId || memory.title;
      recalled.set(key, memory);
    }
  }
  return [...recalled.values()];
}
