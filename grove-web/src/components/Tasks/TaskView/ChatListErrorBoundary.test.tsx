// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatListErrorBoundary } from "./ChatListErrorBoundary";

describe("ChatListErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
  });

  it("contains a child crash and retries the chat list", () => {
    let shouldThrow = true;
    const ChatList = () => {
      if (shouldThrow) throw new Error("Virtuoso failed");
      return <div>Recovered messages</div>;
    };

    act(() => {
      root.render(
        <ChatListErrorBoundary
          resetKey="chat-a"
          projectId="project-a"
          taskId="task-a"
        >
          <ChatList />
        </ChatListErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("Chat list stopped unexpectedly");
    expect(document.body.textContent).not.toBe("");
    expect(consoleError).toHaveBeenCalledWith(
      "[ChatListErrorBoundary] chat list crashed",
      expect.objectContaining({
        projectId: "project-a",
        taskId: "task-a",
        chatId: "chat-a",
      }),
    );

    shouldThrow = false;
    const retry = container.querySelector("button");
    expect(retry).not.toBeNull();
    act(() => retry?.click());

    expect(container.textContent).toContain("Recovered messages");
  });

  it("copies developer-readable diagnostics with chat context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const ChatList = () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    };

    act(() => {
      root.render(
        <ChatListErrorBoundary
          resetKey="chat-a"
          projectId="project-a"
          taskId="task-a"
        >
          <ChatList />
        </ChatListErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("Copy diagnostics");
    expect(container.textContent).toContain("Show crash details");
    const details = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Chat crash diagnostics"]',
    );
    expect(details?.value).toContain(
      "TypeError: Failed to fetch dynamically imported module",
    );
    expect(details?.value).toContain("Project: project-a");
    expect(details?.value).toContain("Task: task-a");
    expect(details?.value).toContain("Chat: chat-a");

    const copyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Copy diagnostics",
    );
    expect(copyButton).toBeDefined();
    await act(async () => copyButton?.click());

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Chat context:\nProject: project-a"),
    );
    expect(container.textContent).toContain("Diagnostics copied");
  });

  it("resets automatically when the active chat changes", () => {
    const ChatList = ({ shouldThrow }: { shouldThrow: boolean }) => {
      if (shouldThrow) throw new Error("Virtuoso failed");
      return <div>Next chat messages</div>;
    };

    act(() => {
      root.render(
        <ChatListErrorBoundary
          resetKey="chat-a"
          projectId="project-a"
          taskId="task-a"
        >
          <ChatList shouldThrow />
        </ChatListErrorBoundary>,
      );
    });
    expect(container.textContent).toContain("Chat list stopped unexpectedly");

    act(() => {
      root.render(
        <ChatListErrorBoundary
          resetKey="chat-b"
          projectId="project-a"
          taskId="task-a"
        >
          <ChatList shouldThrow={false} />
        </ChatListErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("Next chat messages");
  });
});
