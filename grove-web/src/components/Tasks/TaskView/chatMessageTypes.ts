// Chat message model shared by TaskChat and its pure derivation helpers
// (taskChatRenderItems). Extracted verbatim from TaskChat.tsx so the render-item
// builders can live in a testable pure module without importing the ~10k-line
// component. Types only — erased at runtime, no behavior change.

import type { AcpElicitationSnapshot, AskFormDefinition } from "./formPillTypes";
import type { AgentContentBlock } from "./agentContentBlocks";
import type { ToolCallMessage } from "./toolCallReducer";

export type ToolMessage = ToolCallMessage;

export interface PermOption {
  option_id: string;
  name: string;
  kind: string; // "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

export type PermissionMessage = {
  type: "permission";
  /** Server-assigned id (ACP tool_call_id). Empty for legacy events. */
  id: string;
  description: string;
  options: PermOption[];
  resolved?: string; // selected option name when resolved
};

export interface Attachment {
  type: "image" | "audio" | "resource";
  data: string; // base64 for image/audio
  mimeType: string;
  name: string; // original filename
  label: string; // display label e.g. "Image #1", "Audio #2", "File #3"
  previewUrl?: string; // blob URL for image preview
  uri?: string;
  size?: number;
  /** Raw file pending upload — upload is deferred until the prompt is sent */
  pendingFile?: File;
}

export interface TurnUsageData {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedReadTokens?: number;
}

export type AskFormMessage = {
  /** Special-case rendering of the `ask_form` MCP tool call: instead of a
   *  collapsed tool card we show an interactive form (FormPill). The agent
   *  hits `ask_form` → ACP transports the tool_call event to chat → here we
   *  detect it and create this message variant; the user fills it and we send
   *  the markdown answers back through the regular user-prompt channel. */
  type: "ask_form";
  /** ACP tool_call id. Stable across tool_call_update events. */
  id: string;
  /** Validated form definition used by the dedicated form experience. */
  definition: AskFormDefinition;
  /** Set to true locally once the user submits / skips / cancels — the next
   *  render returns null so the pill disappears. */
  resolved?: boolean;
};

export type ElicitationMessage = {
  type: "elicitation";
  id: string;
  snapshot: AcpElicitationSnapshot;
  resolved?: "accept" | "decline" | "cancel" | "complete";
  error?: string;
};

export type ChatMessage =
  | {
      type: "user";
      content: string;
      sender?: string;
      attachments?: Attachment[];
      terminal?: boolean;
    }
  | {
      type: "assistant";
      content: string;
      complete: boolean;
      /** Ordered ACP content blocks. Absent for legacy text-only cached state. */
      blocks?: AgentContentBlock[];
      /** Per-turn token accounting from the agent's PromptResponse, attached
       * by the `complete` reducer to the most recent assistant message in
       * the turn. Absent on streaming messages and on agents that don't
       * report usage. */
      usage?: TurnUsageData;
      /** Wall-clock seconds when grove dispatched the prompt RPC. */
      startTs?: number;
      /** Wall-clock seconds when the prompt response arrived. */
      endTs?: number;
    }
  | { type: "thinking"; content: string; collapsed: boolean; complete: boolean }
  | ToolMessage
  | AskFormMessage
  | ElicitationMessage
  | { type: "system"; content: string }
  | PermissionMessage
  | { type: "terminal_output"; chunks: string[]; exitCode?: number | null }
  | {
      // ACP -32000 AuthRequired banner. methods 来自 initialize 时 agent 声明
      // 的 auth_methods 全集 — 每一个渲染成一个登录按钮,用户点哪个就用哪种。
      // 空数组 = agent 没声明任何方法,显示手动登录提示。
      type: "auth_required";
      methods: { id: string; name: string; description?: string }[];
      agentName: string | null;
      status: "idle" | "in_progress" | "succeeded" | "failed";
      // 用户点击的按钮 id;in_progress / succeeded 时用来高亮和显示文案。
      activeMethodId?: string;
      errorMessage?: string;
    };
