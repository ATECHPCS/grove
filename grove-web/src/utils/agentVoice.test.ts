// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentVoicePlaybackQueue,
  clearPendingAgentVoiceInstruction,
  hasPendingAgentVoiceInstruction,
  listStoredAgentVoiceStates,
  loadAgentVoiceState,
  markAgentVoiceInstructionPending,
  saveAgentVoiceState,
  shouldPlayAgentVoiceAudio,
  type AgentVoiceAudioEvent,
} from "./agentVoice";

function event(chatId: string, profileId: string, audio = "QQ=="): AgentVoiceAudioEvent {
  return {
    type: "agent_voice_audio",
    request_id: `${chatId}-${audio}`,
    chat_id: chatId,
    profile_id: profileId,
    profile_name: profileId,
    mime_type: "audio/mpeg",
    audio_base64: audio,
    max_duration_seconds: 30,
  };
}

async function flushPlayback(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Agent Voice Session storage", () => {
  beforeAll(() => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } satisfies Storage;
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  });

  beforeEach(() => localStorage.clear());

  it("defaults every new Session to disabled", () => {
    expect(loadAgentVoiceState("project", "task", "new-chat")).toEqual({
      enabled: false,
      speakingProfileId: null,
    });
  });

  it("persists independently by Project, Task, and Session", () => {
    saveAgentVoiceState("project", "task", "chat-a", {
      enabled: true,
      speakingProfileId: "profile-a",
    });
    saveAgentVoiceState("project", "task", "chat-b", {
      enabled: false,
      speakingProfileId: "profile-b",
    });

    expect(loadAgentVoiceState("project", "task", "chat-a")).toEqual({
      enabled: true,
      speakingProfileId: "profile-a",
    });
    expect(loadAgentVoiceState("project", "task", "chat-b")).toEqual({
      enabled: false,
      speakingProfileId: "profile-b",
    });
    expect(listStoredAgentVoiceStates()).toEqual([
      {
        projectId: "project",
        taskId: "task",
        chatId: "chat-a",
        enabled: true,
        speakingProfileId: "profile-a",
      },
      {
        projectId: "project",
        taskId: "task",
        chatId: "chat-b",
        enabled: false,
        speakingProfileId: "profile-b",
      },
    ]);
  });

  it("persists an instruction change until the next prompt consumes it", () => {
    expect(hasPendingAgentVoiceInstruction("project", "task", "chat-a")).toBe(false);
    markAgentVoiceInstructionPending("project", "task", "chat-a");
    expect(hasPendingAgentVoiceInstruction("project", "task", "chat-a")).toBe(true);
    expect(hasPendingAgentVoiceInstruction("project", "task", "chat-b")).toBe(false);
    clearPendingAgentVoiceInstruction("project", "task", "chat-a");
    expect(hasPendingAgentVoiceInstruction("project", "task", "chat-a")).toBe(false);
  });

  it("rejects audio delivered after its Session was disabled or changed profile", () => {
    const audio = event("chat-a", "profile-a");
    expect(shouldPlayAgentVoiceAudio(audio, { enabled: false, speakingProfileId: "profile-a" })).toBe(false);
    expect(shouldPlayAgentVoiceAudio(audio, { enabled: true, speakingProfileId: "profile-b" })).toBe(false);
    expect(shouldPlayAgentVoiceAudio(audio, { enabled: true, speakingProfileId: "profile-a" })).toBe(true);
  });
});

describe("Agent Voice page playback queue", () => {
  type FakeSource = {
    buffer: AudioBuffer | null;
    onended: (() => void) | null;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };

  function harness() {
    const starts: string[] = [];
    const sources: FakeSource[] = [];
    const timeouts: Array<{ callback: () => void; delay: number }> = [];
    const context = {
      state: "running",
      destination: {},
      resume: vi.fn(async () => undefined),
      decodeAudioData: vi.fn(async (data: ArrayBuffer) => ({
        marker: String.fromCharCode(...new Uint8Array(data)),
      }) as unknown as AudioBuffer),
      createBufferSource: vi.fn(() => {
        const source: FakeSource = {
          buffer: null,
          onended: null,
          connect: vi.fn(),
          start: vi.fn(() => {
            starts.push((source.buffer as unknown as { marker: string }).marker);
          }),
          stop: vi.fn(() => source.onended?.()),
        };
        sources.push(source);
        return source as unknown as AudioBufferSourceNode;
      }),
    } as unknown as AudioContext;
    const queue = new AgentVoicePlaybackQueue(
      () => context,
      (callback, delay) => {
        timeouts.push({ callback, delay });
        return timeouts.length;
      },
    );
    return { context, queue, sources, starts, timeouts };
  }

  it("plays different Sessions strictly one at a time in arrival order", async () => {
    const { queue, sources, starts } = harness();
    queue.enqueue(event("chat-a", "profile-a", "QQ=="));
    queue.enqueue(event("chat-b", "profile-b", "Qg=="));
    queue.enqueue(event("chat-c", "profile-c", "Qw=="));

    await flushPlayback();
    expect(starts).toEqual(["A"]);
    sources[0].onended?.();
    await flushPlayback();
    expect(starts).toEqual(["A", "B"]);
    sources[1].onended?.();
    await flushPlayback();
    expect(starts).toEqual(["A", "B", "C"]);
    sources[2].onended?.();
    await flushPlayback();
  });

  it("disabling one Session removes only its queued and active audio", async () => {
    const { queue, sources, starts } = harness();
    queue.enqueue(event("chat-a", "profile-a", "QQ=="));
    queue.enqueue(event("chat-b", "profile-b", "Qg=="));
    queue.enqueue(event("chat-c", "profile-c", "Qw=="));

    await flushPlayback();
    queue.cancelSession("chat-b");
    expect(sources[0].stop).not.toHaveBeenCalled();
    sources[0].onended?.();
    await flushPlayback();
    expect(starts).toEqual(["A", "C"]);

    queue.cancelSession("chat-c");
    expect(sources[1].stop).toHaveBeenCalledOnce();
    await flushPlayback();
  });

  it("stops playback at the Speaking Profile duration limit", async () => {
    const { queue, sources, timeouts } = harness();
    queue.enqueue({ ...event("chat-a", "profile-a"), max_duration_seconds: 12 });
    await flushPlayback();

    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].delay).toBe(12_000);
    timeouts[0].callback();
    expect(sources[0].stop).toHaveBeenCalledOnce();
    await flushPlayback();
  });

  it("reports queued, playing, and idle so the Session can expose playback controls", async () => {
    const { queue, sources } = harness();
    const statuses: string[] = [];
    queue.subscribe((chatId, status) => {
      if (chatId === "chat-a" && statuses.at(-1) !== status) statuses.push(status);
    });

    queue.enqueue(event("chat-a", "profile-a"));
    expect(statuses).toEqual(["queued"]);
    await flushPlayback();
    expect(statuses).toEqual(["queued", "playing"]);

    queue.cancelSession("chat-a");
    await flushPlayback();
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(statuses).toEqual(["queued", "playing", "idle"]);
  });

  it("exposes one global playback state and lets any page stop it", async () => {
    const { queue, sources } = harness();
    const statuses: string[] = [];
    const unsubscribe = queue.subscribeGlobal((playback) => {
      statuses.push(`${playback.status}:${playback.event?.chat_id ?? "none"}`);
    });

    queue.enqueue(event("chat-a", "profile-a"));
    await flushPlayback();
    expect(statuses).toContain("queued:chat-a");
    expect(statuses).toContain("playing:chat-a");

    queue.cancelSession("chat-a");
    expect(sources[0].stop).toHaveBeenCalledOnce();
    await flushPlayback();
    expect(statuses.at(-1)).toBe("idle:none");
    unsubscribe();
  });
});
