import { Code2, Sparkles } from "lucide-react";

interface ProjectTypeBadgeProps {
  type: "studio" | "repo" | string | undefined;
}

export function ProjectTypeBadge({ type }: ProjectTypeBadgeProps) {
  const isStudio = type === "studio";
  const Icon = isStudio ? Sparkles : Code2;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
        isStudio
          ? "border-[var(--color-highlight)]/20 bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
          : "border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]"
      }`}
    >
      <Icon className="h-2.5 w-2.5" />
      {isStudio ? "Studio" : "Code"}
    </span>
  );
}
