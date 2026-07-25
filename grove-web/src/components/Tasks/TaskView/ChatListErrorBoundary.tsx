import { Component, type ErrorInfo, type ReactNode } from "react";

import {
  createClientErrorReport,
  formatClientErrorReport,
  type ClientErrorReport,
} from "../../../errors/clientErrorReport";

interface ChatListErrorBoundaryProps {
  children: ReactNode;
  resetKey: string | null;
  projectId: string;
  taskId: string;
}

interface ChatListErrorBoundaryState {
  error: Error | null;
  report: ClientErrorReport | null;
  copied: boolean;
}

/**
 * Keeps a virtualized chat-list failure scoped to the message viewport.
 * Switching chats or pressing Retry mounts a fresh Virtuoso instance.
 */
export class ChatListErrorBoundary extends Component<
  ChatListErrorBoundaryProps,
  ChatListErrorBoundaryState
> {
  state: ChatListErrorBoundaryState = {
    error: null,
    report: null,
    copied: false,
  };

  static getDerivedStateFromError(error: Error): Partial<ChatListErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const report = createClientErrorReport(error, {
      source: "react-caught",
      componentStack: info.componentStack ?? undefined,
    });
    console.error("[ChatListErrorBoundary] chat list crashed", {
      error,
      componentStack: info.componentStack,
      projectId: this.props.projectId,
      taskId: this.props.taskId,
      chatId: this.props.resetKey,
    });
    this.setState({ report });
  }

  componentDidUpdate(prevProps: ChatListErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, report: null, copied: false });
    }
  }

  private retry = () => {
    this.setState({ error: null, report: null, copied: false });
  };

  private getDiagnostics = (): string => {
    const report =
      this.state.report ??
      createClientErrorReport(this.state.error, { source: "react-caught" });
    return [
      formatClientErrorReport(report),
      "",
      "Chat context:",
      `Project: ${this.props.projectId}`,
      `Task: ${this.props.taskId}`,
      `Chat: ${this.props.resetKey ?? "unknown"}`,
    ].join("\n");
  };

  private copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(this.getDiagnostics());
      this.setState({ copied: true });
    } catch (error) {
      console.warn("[ChatListErrorBoundary] failed to copy diagnostics", error);
      this.setState({ copied: false });
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div
        className="flex h-full min-h-0 flex-1 items-center justify-center px-6"
        role="alert"
      >
        <div className="w-full max-w-2xl rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 text-center shadow-sm">
          <div className="text-sm font-medium text-[var(--color-text)]">
            Chat list stopped unexpectedly
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
            The rest of Grove is still available. Retry to rebuild this chat's
            message list.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={this.retry}
              className="rounded-lg bg-[var(--color-highlight)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
            >
              Retry chat list
            </button>
            <button
              type="button"
              onClick={() => void this.copyDiagnostics()}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
            >
              {this.state.copied ? "Diagnostics copied" : "Copy diagnostics"}
            </button>
          </div>
          <details className="mt-4 text-left">
            <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-muted)]">
              Show crash details
            </summary>
            <textarea
              readOnly
              value={this.getDiagnostics()}
              aria-label="Chat crash diagnostics"
              className="mt-3 h-48 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[11px] leading-5 text-[var(--color-text-muted)] outline-none"
              onFocus={(event) => event.currentTarget.select()}
            />
          </details>
        </div>
      </div>
    );
  }
}
