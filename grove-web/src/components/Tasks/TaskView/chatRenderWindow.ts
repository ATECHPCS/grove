// Chat view render-window policy (tranche-2 perf). The chat rebuilds its
// render-item + minimap derivations from scratch over the whole `messages`
// array on every streamed token, so an unbounded transcript makes a streaming
// turn cost O(history × tokens) — a full rebuild grows to ~8ms at 3k+ messages
// (see taskChatRenderItems.test.ts). Bounding the derived/mounted set keeps the
// per-token cost flat regardless of conversation length. Pruned turns leave the
// *view* only (a banner is shown); the full history stays on disk and is still
// served by the history API.
//
// Pure + colocated-tested (chatRenderWindow.test.ts) so the defaulting rules are
// locked independently of the ~14k-line TaskChat component.

export type ChatRenderWindowSettings = {
  limit: number;
  trigger: number;
};

// Default view window applied when `render_window_limit` is unset. An explicit
// `0` remains an opt-out (unbounded) — only an *unset* config gets this default.
export const DEFAULT_CHAT_RENDER_WINDOW_LIMIT = 600;

export function normalizeChatRenderWindowSettings(
  limit?: number,
  trigger?: number,
): ChatRenderWindowSettings {
  // Distinguish "unset" (→ apply the default window) from an explicit 0
  // (→ disabled / unbounded). Both used to collapse to 0.
  const effectiveLimit =
    limit === undefined ? DEFAULT_CHAT_RENDER_WINDOW_LIMIT : limit;
  const normalizedLimit = Number.isFinite(effectiveLimit)
    ? Math.max(0, Math.floor(effectiveLimit))
    : DEFAULT_CHAT_RENDER_WINDOW_LIMIT;
  const normalizedTrigger = Number.isFinite(trigger)
    ? Math.max(0, Math.floor(trigger ?? 0))
    : 0;

  if (normalizedLimit === 0) {
    return {
      limit: 0,
      trigger: normalizedTrigger || 1500,
    };
  }

  return {
    limit: normalizedLimit,
    trigger:
      normalizedTrigger > normalizedLimit
        ? normalizedTrigger
        : normalizedLimit + 500,
  };
}

/** Drop the oldest messages from the view once the count crosses `trigger`,
 *  keeping the most recent `limit`. Generic over the element type: it only reads
 *  `.length` and slices, so it never depends on the ChatMessage shape. */
export function pruneChatViewMessages<T>(
  messages: T[],
  hiddenMessageCount: number,
  settings: ChatRenderWindowSettings,
): { messages: T[]; hiddenMessageCount: number; pruned: boolean } {
  if (
    settings.limit <= 0 ||
    settings.trigger <= settings.limit ||
    messages.length < settings.trigger
  ) {
    return { messages, hiddenMessageCount, pruned: false };
  }

  const removeCount = messages.length - settings.limit;
  if (removeCount <= 0) {
    return { messages, hiddenMessageCount, pruned: false };
  }

  return {
    messages: messages.slice(removeCount),
    hiddenMessageCount: hiddenMessageCount + removeCount,
    pruned: true,
  };
}
