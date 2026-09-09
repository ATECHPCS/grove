export type AgentVoiceSessionState = {
  enabled: boolean;
  speakingProfileId: string | null;
};

export type AgentVoiceAudioEvent = {
  type: "agent_voice_audio";
  request_id: string;
  chat_id: string;
  profile_id: string;
  profile_name: string;
  mime_type: string;
  audio_base64: string;
  max_duration_seconds: number;
};

export type AgentVoiceErrorEvent = {
  type: "agent_voice_error";
  request_id: string;
  chat_id: string;
  message: string;
};

const STORAGE_PREFIX = "grove:agent-voice:v1";
const PENDING_INSTRUCTION_PREFIX = "grove:agent-voice-instruction-pending:v1";
export const AGENT_VOICE_STATE_CHANGED_EVENT = "grove:agent-voice-state-changed";

export type StoredAgentVoiceState = AgentVoiceSessionState & {
  projectId: string;
  taskId: string;
  chatId: string;
};

function storageKey(projectId: string, taskId: string, chatId: string): string {
  return `${STORAGE_PREFIX}:${projectId}:${taskId}:${chatId}`;
}

function pendingInstructionKey(projectId: string, taskId: string, chatId: string): string {
  return `${PENDING_INSTRUCTION_PREFIX}:${projectId}:${taskId}:${chatId}`;
}

export function markAgentVoiceInstructionPending(
  projectId: string,
  taskId: string,
  chatId: string,
): void {
  localStorage.setItem(pendingInstructionKey(projectId, taskId, chatId), "1");
}

export function hasPendingAgentVoiceInstruction(
  projectId: string,
  taskId: string,
  chatId: string,
): boolean {
  return localStorage.getItem(pendingInstructionKey(projectId, taskId, chatId)) === "1";
}

export function clearPendingAgentVoiceInstruction(
  projectId: string,
  taskId: string,
  chatId: string,
): void {
  localStorage.removeItem(pendingInstructionKey(projectId, taskId, chatId));
}

export function loadAgentVoiceState(
  projectId: string,
  taskId: string,
  chatId: string,
): AgentVoiceSessionState {
  try {
    const value = localStorage.getItem(storageKey(projectId, taskId, chatId));
    if (!value) return { enabled: false, speakingProfileId: null };
    const parsed = JSON.parse(value) as Partial<AgentVoiceSessionState>;
    return {
      enabled: parsed.enabled === true,
      speakingProfileId: typeof parsed.speakingProfileId === "string" ? parsed.speakingProfileId : null,
    };
  } catch {
    return { enabled: false, speakingProfileId: null };
  }
}

export function saveAgentVoiceState(
  projectId: string,
  taskId: string,
  chatId: string,
  state: AgentVoiceSessionState,
): void {
  localStorage.setItem(storageKey(projectId, taskId, chatId), JSON.stringify(state));
  window.dispatchEvent(new CustomEvent<StoredAgentVoiceState>(AGENT_VOICE_STATE_CHANGED_EVENT, {
    detail: { projectId, taskId, chatId, ...state },
  }));
}

export function listStoredAgentVoiceStates(): StoredAgentVoiceState[] {
  const states: StoredAgentVoiceState[] = [];
  const prefix = `${STORAGE_PREFIX}:`;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const [projectId, taskId, chatId] = key.slice(prefix.length).split(":");
    if (!projectId || !taskId || !chatId) continue;
    const state = loadAgentVoiceState(projectId, taskId, chatId);
    states.push({ projectId, taskId, chatId, ...state });
  }
  return states;
}

type QueueItem = AgentVoiceAudioEvent;

export type AgentVoicePlaybackStatus = "idle" | "queued" | "playing";
type PlaybackListener = (chatId: string, status: AgentVoicePlaybackStatus) => void;
export type GlobalAgentVoicePlayback = {
  status: AgentVoicePlaybackStatus;
  event: AgentVoiceAudioEvent | null;
};
type GlobalPlaybackListener = (playback: GlobalAgentVoicePlayback) => void;

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function shouldPlayAgentVoiceAudio(
  event: AgentVoiceAudioEvent,
  state: AgentVoiceSessionState,
): boolean {
  return state.enabled && state.speakingProfileId === event.profile_id;
}

type AudioContextFactory = () => AudioContext;
type TimeoutScheduler = (callback: () => void, delay: number) => number;

/**
 * One application-level playback owner for every connected Session. Calls from all
 * TaskChat instances enter the same FIFO and therefore never overlap.
 */
export class AgentVoicePlaybackQueue {
  private readonly queue: QueueItem[] = [];
  private processing = false;
  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private currentItem: QueueItem | null = null;
  private currentChatId: string | null = null;
  private readonly listeners = new Set<PlaybackListener>();
  private readonly globalListeners = new Set<GlobalPlaybackListener>();
  private readonly createAudioContext: AudioContextFactory;
  private readonly scheduleTimeout: TimeoutScheduler;

  constructor(
    createAudioContext: AudioContextFactory = () => new AudioContext(),
    scheduleTimeout: TimeoutScheduler = (callback, delay) => window.setTimeout(callback, delay),
  ) {
    this.createAudioContext = createAudioContext;
    this.scheduleTimeout = scheduleTimeout;
  }

  private context(): AudioContext {
    if (!this.audioContext) this.audioContext = this.createAudioContext();
    return this.audioContext;
  }

  async unlock(): Promise<void> {
    const ctx = this.context();
    if (ctx.state === "suspended") await ctx.resume();
  }

  enqueue(event: AgentVoiceAudioEvent): void {
    this.queue.push(event);
    this.emit(event.chat_id);
    void this.drain();
  }

  statusForSession(chatId: string): AgentVoicePlaybackStatus {
    if (this.currentChatId === chatId && this.currentSource) return "playing";
    if (this.currentChatId === chatId || this.queue.some((item) => item.chat_id === chatId)) return "queued";
    return "idle";
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeGlobal(listener: GlobalPlaybackListener): () => void {
    this.globalListeners.add(listener);
    listener(this.globalStatus());
    return () => this.globalListeners.delete(listener);
  }

  private globalStatus(): GlobalAgentVoicePlayback {
    if (this.currentItem) {
      return { status: this.currentSource ? "playing" : "queued", event: this.currentItem };
    }
    return { status: this.queue.length > 0 ? "queued" : "idle", event: this.queue[0] ?? null };
  }

  private emit(chatId: string): void {
    const status = this.statusForSession(chatId);
    for (const listener of this.listeners) listener(chatId, status);
    const globalStatus = this.globalStatus();
    for (const listener of this.globalListeners) listener(globalStatus);
  }

  cancelSession(chatId: string): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index].chat_id === chatId) this.queue.splice(index, 1);
    }
    if (this.currentChatId === chatId) {
      try {
        if (this.currentSource) {
          this.currentSource.stop();
        } else {
          this.currentItem = null;
          this.currentChatId = null;
          this.emit(chatId);
        }
      } catch {
        // The source may have ended between the user's click and this call.
      }
    } else {
      this.emit(chatId);
    }
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;
        try {
          this.currentChatId = item.chat_id;
          this.currentItem = item;
          this.emit(item.chat_id);
          const ctx = this.context();
          if (ctx.state === "suspended") await ctx.resume();
          const buffer = await ctx.decodeAudioData(decodeBase64(item.audio_base64));
          if (this.currentItem !== item) continue;
          await new Promise<void>((resolve) => {
            const source = ctx.createBufferSource();
            this.currentSource = source;
            source.buffer = buffer;
            source.connect(ctx.destination);
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              this.currentSource = null;
              this.currentItem = null;
              this.currentChatId = null;
              this.emit(item.chat_id);
              resolve();
            };
            source.onended = finish;
            source.start();
            this.emit(item.chat_id);
            this.scheduleTimeout(() => {
              if (!settled) source.stop();
            }, Math.max(1, item.max_duration_seconds) * 1000);
          });
        } catch (error) {
          this.currentSource = null;
          this.currentItem = null;
          this.currentChatId = null;
          this.emit(item.chat_id);
          console.error("[Agent Voice] playback failed", error);
        }
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) void this.drain();
    }
  }
}

const playbackQueue = new AgentVoicePlaybackQueue();

export function unlockAgentVoiceAudio(): Promise<void> {
  return playbackQueue.unlock();
}

export function enqueueAgentVoiceAudio(event: AgentVoiceAudioEvent): void {
  playbackQueue.enqueue(event);
}

export function cancelAgentVoiceForSession(chatId: string): void {
  playbackQueue.cancelSession(chatId);
}

export function subscribeAgentVoicePlayback(
  chatId: string,
  listener: (status: AgentVoicePlaybackStatus) => void,
): () => void {
  listener(playbackQueue.statusForSession(chatId));
  return playbackQueue.subscribe((changedChatId, status) => {
    if (changedChatId === chatId) listener(status);
  });
}

export function subscribeGlobalAgentVoicePlayback(
  listener: GlobalPlaybackListener,
): () => void {
  return playbackQueue.subscribeGlobal(listener);
}
