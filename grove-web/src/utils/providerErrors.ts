type ProviderErrorOptions = {
  fallback: string;
  backendRestartMessage?: string;
};

function rawMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (reason && typeof reason === "object" && "message" in reason && typeof reason.message === "string") {
    return reason.message;
  }
  return "";
}

export function formatProviderError(reason: unknown, options: ProviderErrorOptions): string {
  const message = rawMessage(reason);
  const normalized = message.toLowerCase();

  if (normalized.includes("voices_read") || normalized.includes("permission voices")) {
    return "ElevenLabs API key needs Voices access. Enable Voices for this restricted key, then test the connection again.";
  }
  if (normalized.includes("text_to_speech") || normalized.includes("text to speech")) {
    return "ElevenLabs API key needs Text to Speech access. Enable it for this restricted key, then test the connection again.";
  }
  if (
    options.backendRestartMessage
    && (normalized.includes("expected pattern")
      || normalized.includes("expected json")
      || normalized.includes("unexpected character")
      || normalized.includes("unexpected token"))
  ) {
    return options.backendRestartMessage;
  }
  if (!message) return options.fallback;

  // Provider responses can contain a full JSON error body. Keep the useful
  // prefix without rendering request ids and vendor payloads across the page.
  const withoutPayload = message.replace(/:\s*\{[\s\S]*$/, "").trim();
  return withoutPayload || options.fallback;
}
