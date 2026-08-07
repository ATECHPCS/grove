import { ExternalLink, Link2, ShieldAlert, X } from "lucide-react";
import { Button } from "../../ui";

interface Props {
  agentName: string;
  message: string;
  url: string;
  opened: boolean;
  onOpen: () => void;
  onDecline: () => void;
  onCancel: () => void;
  disabled?: boolean;
}

export function ElicitationUrlPill({
  agentName,
  message,
  url,
  opened,
  onOpen,
  onDecline,
  onCancel,
  disabled = false,
}: Props) {
  let host = url;
  let insecure = false;
  let suspicious = false;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    insecure = parsed.protocol !== "https:";
    suspicious = parsed.hostname.includes("xn--");
  } catch {
    // The backend rejects malformed URLs. Keep the full value visible if an
    // older backend sends one so the UI never hides the actual destination.
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link2 className="h-4 w-4 shrink-0 text-[var(--color-highlight)]" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-[var(--color-text)]">
              {agentName} requests to open a website
            </div>
            <div className="truncate text-xs text-[var(--color-text-muted)]">{host}</div>
          </div>
        </div>
        {!opened && (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" disabled={disabled} onClick={onCancel}>
              <X className="mr-1 h-3.5 w-3.5" /> Cancel
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={onDecline}>Decline</Button>
            <Button variant="primary" size="sm" disabled={disabled} onClick={onOpen}>
              <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open in Browser
            </Button>
          </div>
        )}
      </div>

      <p className="whitespace-pre-wrap break-words text-sm text-[var(--color-text)]">{message}</p>

      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
        <div className="break-all font-mono text-xs text-[var(--color-text-secondary)]">{url}</div>
      </div>

      {insecure && (
        <div className="flex items-start gap-2 text-xs text-[var(--color-warning)]">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This connection is not encrypted. Check the address before continuing.
        </div>
      )}

      {suspicious && (
        <div className="flex items-start gap-2 text-xs text-[var(--color-warning)]">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This address uses an internationalized domain. Verify the full URL carefully.
        </div>
      )}

      {opened && (
        <div className="flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
          <span>Opened in your browser. Waiting for the Agent to confirm completion.</span>
          <Button variant="ghost" size="sm" onClick={onOpen}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open Again
          </Button>
        </div>
      )}
    </div>
  );
}
