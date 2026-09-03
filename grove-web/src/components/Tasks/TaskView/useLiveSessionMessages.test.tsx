// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useLiveSessionMessages } from "./useLiveSessionMessages";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("useLiveSessionMessages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps complete live history when a lifecycle restore supplies an empty stale cache", () => {
    let replaceMessages: ((messages: string[]) => void) | null = null;
    let restoreFromCache: ((messages: string[]) => void) | null = null;

    function Harness() {
      const [messages, setMessages] = useState<string[]>([]);
      const { resolveMessages } = useLiveSessionMessages<string>(
        "chat-a",
        messages,
      );
      replaceMessages = setMessages;
      restoreFromCache = (cached) => {
        setMessages(resolveMessages("chat-a", cached));
      };
      return <div>{messages.join("|")}</div>;
    }

    act(() => root.render(<Harness />));
    act(() => replaceMessages?.(["old user", "old answer", "current user"]));

    // session_ready can create a metadata-only PerChatState whose transcript
    // is still empty. A later lifecycle restore used to install that stale
    // value, after which only subsequent assistant chunks remained visible.
    act(() => restoreFromCache?.([]));
    expect(container.textContent).toBe("old user|old answer|current user");

    act(() =>
      replaceMessages?.([
        "old user",
        "old answer",
        "current user",
        "current answer chunk",
      ]),
    );
    expect(container.textContent).toBe(
      "old user|old answer|current user|current answer chunk",
    );
  });
});
