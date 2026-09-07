import type { CSSProperties } from "react";

type VoiceIdentityKind = "voice" | "profile";
type VoiceIdentitySize = "xs" | "sm" | "md" | "xl";

const sizeClasses: Record<VoiceIdentitySize, string> = {
  xs: "h-5 w-5",
  sm: "h-8 w-8",
  md: "h-9 w-9",
  xl: "h-24 w-24 [@media(max-height:760px)]:h-16 [@media(max-height:760px)]:w-16",
};

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function voiceIdentityStyle(kind: VoiceIdentityKind, id: string): CSSProperties {
  const hash = stableHash(`${kind}:${id || "unassigned"}`);
  if (kind === "voice") {
    const hue = hash % 360;
    const secondHue = (hue + 42 + ((hash >>> 8) % 58)) % 360;
    const glowX = 22 + ((hash >>> 16) % 56);
    return {
      background: `radial-gradient(circle at ${glowX}% 22%, hsl(${secondHue} 92% 82%) 0%, transparent 34%), linear-gradient(145deg, hsl(${hue} 84% 66%) 0%, hsl(${secondHue} 76% 42%) 58%, hsl(${(secondHue + 34) % 360} 70% 24%) 100%)`,
    };
  }

  const hue = (hash * 7 + 29) % 360;
  const secondHue = (hue + 118 + ((hash >>> 10) % 46)) % 360;
  return {
    background: `linear-gradient(135deg, hsl(${hue} 72% 72%) 0%, hsl(${secondHue} 68% 48%) 100%)`,
  };
}

export function VoiceIdentityIcon({ kind, id, size = "md", className = "" }: {
  kind: VoiceIdentityKind;
  id: string;
  size?: VoiceIdentitySize;
  className?: string;
}) {
  const shapeClass = kind === "voice"
    ? "rounded-full shadow-inner"
    : "rounded-[30%] shadow-[inset_0_1px_0_rgb(255_255_255/0.42)]";

  return (
    <span
      aria-hidden="true"
      data-voice-identity-kind={kind}
      className={`relative inline-block shrink-0 overflow-hidden ${sizeClasses[size]} ${shapeClass} ${className}`}
      style={voiceIdentityStyle(kind, id)}
    >
      {kind === "profile" && (
        <span className="absolute inset-[22%] rounded-full border border-white/70 shadow-[0_0_0_2px_rgb(255_255_255/18%)]" />
      )}
    </span>
  );
}
