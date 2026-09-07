export type TabId = "audio" | "voice_control" | "providers" | "agent_voice";

export type ProviderStatus = "verified" | "draft" | "failed";

export type ProviderProfile = {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  status: ProviderStatus;
  supportsSpeaking?: boolean;
};

export type SpeakingProfileConfig = Record<string, string | number | boolean>;

export type SpeakingProviderField = {
  key: string;
  label: string;
  description?: string;
  type: "voice" | "text" | "number" | "range" | "boolean" | "select";
  defaultValue: string | number | boolean;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{
    value: string;
    label: string;
    description?: string;
    badge?: string;
    metadata?: string[];
    disabledFieldKeys?: string[];
  }>;
};

export type SpeakingProviderSchema = {
  providerType: string;
  fields: SpeakingProviderField[];
};

export type SpeakingProfile = {
  id: string;
  name: string;
  providerId: string;
  config: SpeakingProfileConfig;
  maxCharacters: number;
  maxDurationSeconds: number;
};

export type SpeakingVoice = {
  voiceId: string;
  name: string;
  category?: string;
  description?: string;
  previewUrl?: string;
  language?: string;
  locale?: string;
  accent?: string;
  gender?: string;
  age?: string;
  useCase?: string;
  supportedModelIds?: string[];
  source?: string;
};

export type SpeakingVoicePage = {
  voices: SpeakingVoice[];
  hasMore: boolean;
  nextPageToken?: string;
  totalCount?: number;
};

export type SpeakingVoiceQuery = {
  search?: string;
  voiceType?: string;
  language?: string;
  voiceId?: string;
  nextPageToken?: string;
  pageSize?: number;
};

export type ReplacementRule = { from: string; to: string };

export type TranscribeMode = "batch" | "streaming";

export type AudioSettings = {
  enabled: boolean;
  /** Transcription mode: 'batch' (record then transcribe) or 'streaming' (live) */
  transcribeMode: TranscribeMode;
  /** Whether OS-wide global voice mode is enabled (global shortcut + floating widget) */
  globalModeEnabled: boolean;
  transcribeProvider: string;
  preferredLanguages: string[];
  /** Combo key shortcut for toggle mode (e.g. "Cmd+Shift+.") — empty = disabled */
  toggleShortcut: string;
  /** Single key for push-to-talk mode (e.g. "F5") — empty = disabled */
  pushToTalkKey: string;
  /** How long the PTT key must be held before recording starts (ms, default 500) */
  pttActivationDelayMs: number;
  /** Max recording duration in seconds (default 60) */
  maxDuration: number;
  /** Min recording duration in seconds; below = discard as accidental (default 2) */
  minDuration: number;
  reviseEnabled: boolean;
  reviseProvider: string;
  revisePromptGlobal: string;
  revisePromptProject: string;
  preferredTermsGlobal: string[];
  preferredTermsProject: string[];
  forbiddenTermsGlobal: string[];
  forbiddenTermsProject: string[];
  replacementsGlobal: ReplacementRule[];
  replacementsProject: ReplacementRule[];
};

export type VoiceControlSettings = {
  enabled: boolean;
  sttProviderId: string;
  sttModel: string;
  llmProviderId: string;
  llmModel: string;
  toggleShortcut: string;
  pushToTalkKey: string;
  pttActivationDelayMs: number;
  maxDuration: number;
  minDuration: number;
  preferredLanguages: string[];
  disabledActions: string[];
  hasInitializedActions?: boolean;
};
