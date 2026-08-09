import type { ToolCallMessage } from "./toolCallReducer";

function isMemoryReadTool(message: ToolCallMessage): boolean {
  const toolName = message.input
    ?.find((field) => field.label.trim().toLowerCase() === "tool")
    ?.value.trim()
    .toLowerCase();
  return (
    toolName === "memory_read" ||
    /(?:^|[./\s:])memory_read$/i.test(message.title.trim())
  );
}

function memoryEntityId(message: ToolCallMessage): string | undefined {
  return message.input
    ?.find((field) => field.label.toLowerCase().replace(/[^a-z0-9]/g, "").endsWith("entityid"))
    ?.value.trim() || undefined;
}

/** Collect Entity IDs from successful memory_read calls in the current user turn. */
export function collectCurrentTurnReadMemoryIds(
  messages: readonly { type: string }[],
): string[] {
  let turnStart = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].type === "user") {
      turnStart = i;
      break;
    }
  }

  const read = new Set<string>();
  for (let i = turnStart + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.type !== "tool") continue;
    const tool = message as ToolCallMessage;
    if (!isMemoryReadTool(tool) || tool.status !== "completed") continue;
    const entityId = memoryEntityId(tool);
    if (entityId) read.add(entityId);
  }
  return [...read];
}
