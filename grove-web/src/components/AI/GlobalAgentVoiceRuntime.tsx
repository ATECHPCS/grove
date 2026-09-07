import { useEffect, useState } from "react";
import { Loader2, Square } from "lucide-react";
import { appendHmacToUrl, getApiHost } from "../../api/client";
import {
  AGENT_VOICE_STATE_CHANGED_EVENT,
  cancelAgentVoiceForSession,
  enqueueAgentVoiceAudio,
  listStoredAgentVoiceStates,
  shouldPlayAgentVoiceAudio,
  subscribeGlobalAgentVoicePlayback,
  type AgentVoiceAudioEvent,
  type AgentVoiceErrorEvent,
  type GlobalAgentVoicePlayback,
  type StoredAgentVoiceState,
} from "../../utils/agentVoice";
import { VoiceIdentityIcon } from "./components/VoiceIdentityIcon";

/**
 * One application-level transport for Agent Voice. It deliberately lives
 * above every page so navigation never tears down synthesis delivery or the
 * shared FIFO player in agentVoice.ts.
 */
export function GlobalAgentVoiceRuntime() {
  const [playback, setPlayback] = useState<GlobalAgentVoicePlayback>({ status: "idle", event: null });

  useEffect(() => subscribeGlobalAgentVoicePlayback(setPlayback), []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let disposed = false;

    const sendState = (state: StoredAgentVoiceState) => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
        type: "agent_voice_state",
        chat_id: state.chatId,
        enabled: state.enabled,
        profile_id: state.speakingProfileId,
      }));
    };

    const connect = async () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const rawUrl = `${protocol}//${getApiHost()}/api/v1/ai/agent-voice/runtime/ws`;
      const url = await appendHmacToUrl(rawUrl);
      if (disposed) return;
      const nextSocket = new WebSocket(url);
      socket = nextSocket;
      nextSocket.onopen = () => {
        reconnectAttempt = 0;
        for (const state of listStoredAgentVoiceStates()) sendState(state);
      };
      nextSocket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as AgentVoiceAudioEvent | AgentVoiceErrorEvent;
          if (message.type === "agent_voice_audio") {
            const state = listStoredAgentVoiceStates().find((item) => item.chatId === message.chat_id);
            if (state && shouldPlayAgentVoiceAudio(message, state)) enqueueAgentVoiceAudio(message);
          } else if (message.type === "agent_voice_error") {
            window.dispatchEvent(new CustomEvent("grove:agent-voice-error", { detail: message }));
          }
        } catch (error) {
          console.error("[Agent Voice] invalid runtime event", error);
        }
      };
      nextSocket.onclose = () => {
        if (socket === nextSocket) socket = null;
        if (disposed) return;
        const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(() => { void connect(); }, delay);
      };
      nextSocket.onerror = () => nextSocket.close();
    };

    const handleStateChanged = (event: Event) => {
      sendState((event as CustomEvent<StoredAgentVoiceState>).detail);
    };
    window.addEventListener(AGENT_VOICE_STATE_CHANGED_EVENT, handleStateChanged);
    void connect();
    return () => {
      disposed = true;
      window.removeEventListener(AGENT_VOICE_STATE_CHANGED_EVENT, handleStateChanged);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  if (!playback.event || playback.status === "idle") return null;
  return (
    <div className="fixed bottom-5 right-5 z-[9998] flex h-11 max-w-72 items-center gap-2.5 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 shadow-[0_12px_36px_rgba(15,23,42,0.2)]">
      <VoiceIdentityIcon kind="profile" id={playback.event.profile_id} size="xs" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-[var(--color-text)]">{playback.event.profile_name}</span>
        <span className="block text-[10px] text-[var(--color-text-muted)]">{playback.status === "playing" ? "Speaking" : "Preparing"}</span>
      </span>
      {playback.status === "queued" && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-highlight)]" />}
      <button
        type="button"
        aria-label="Stop Agent Voice"
        title="Stop Agent Voice"
        onClick={() => cancelAgentVoiceForSession(playback.event!.chat_id)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-text)] text-[var(--color-bg)] transition-transform hover:scale-105"
      >
        <Square className="h-3 w-3 fill-current" />
      </button>
    </div>
  );
}
