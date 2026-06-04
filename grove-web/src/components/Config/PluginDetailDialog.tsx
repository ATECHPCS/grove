import { useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, X } from "lucide-react";
import { Button } from "../ui";
import { updatePluginSdk, type Plugin } from "../../api/plugins";
import { PluginIcon } from "../Plugins/PluginIcon";

/** Permissions that let a plugin modify files, run commands, or drive the agent
 *  — warning treatment, mirroring PluginsSection's HIGH_RISK handling. */
const HIGH_RISK_PERMISSIONS = new Set(["exec", "project:write", "chat:read", "chat:write", "inject"]);

/** Human labels for declared permission strings; unknown perms fall back to the
 *  raw string so new backend permissions still render legibly. */
const PERMISSION_LABELS: Record<string, string> = {
  "chat:read": "Read chat & AI events",
  "chat:write": "Send prompts to the AI",
};

const permLabel = (perm: string): string => PERMISSION_LABELS[perm] ?? perm;

/** Format an ISO-ish timestamp for display, falling back to the raw string. */
function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

/** One labelled row inside an info block. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
        {label}
      </span>
      <span className="break-all text-xs text-[var(--color-text)]">{children}</span>
    </div>
  );
}

/** A titled section card. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2.5">
      <h3 className="text-xs font-semibold text-[var(--color-text)]">{title}</h3>
      {children}
    </div>
  );
}

/** A small status pill. `tone` picks the color treatment. */
function Pill({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "highlight" | "warning" | "error" | "success";
}) {
  const cls =
    tone === "highlight"
      ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
      : tone === "warning"
        ? "bg-[var(--color-warning)]/10 text-[var(--color-warning)]"
        : tone === "error"
          ? "bg-[var(--color-error)]/10 text-[var(--color-error)]"
          : tone === "success"
            ? "bg-[var(--color-success)]/10 text-[var(--color-success)]"
            : "bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

/**
 * Read-only detail view for a single plugin, opened by clicking a plugin row's
 * name/icon in PluginsSection. Shows basics, contribution points, declared
 * permissions, and runtime/build status. Skills + MCP tool enumeration needs
 * backend support and isn't shown yet — only a placeholder note for now.
 */
export function PluginDetailDialog({ plugin, onClose }: { plugin: Plugin; onClose: () => void }) {
  const c = plugin.contributes;
  const [sdkState, setSdkState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [sdkMsg, setSdkMsg] = useState<string | null>(null);

  // Dev-only: rewrite src/grove-sdk/* to this Grove's SDK version (the SDK is
  // vendored per-plugin, so this is how a dev pulls in host-side changes).
  const onUpdateSdk = async () => {
    setSdkState("running");
    setSdkMsg(null);
    try {
      await updatePluginSdk(plugin.id);
      setSdkState("done");
      setSdkMsg("SDK updated — run `npm run build` to rebuild.");
    } catch (e) {
      setSdkState("error");
      setSdkMsg(e instanceof Error ? e.message : "Update failed");
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-highlight)]/10">
              <PluginIcon plugin={plugin} className="h-5 w-5 text-[var(--color-highlight)]" size={20} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-[var(--color-text)]">
                  {plugin.name}
                </h2>
                <Pill>v{plugin.version}</Pill>
                {plugin.source === "dev" && <Pill tone="highlight">dev</Pill>}
              </div>
              <div className="truncate text-[10px] text-[var(--color-text-muted)]">{plugin.id}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Placeholder note for the not-yet-built capabilities. */}
        <div className="mb-4 rounded-lg border border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/5 px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
          Skill &amp; MCP tool listing, with per-tool visibility control, is coming soon.
        </div>

        <div className="space-y-3">
          {/* Basics */}
          <Section title="Basics">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">{plugin.name}</Field>
              <Field label="Version">v{plugin.version}</Field>
              <Field label="Source">
                <span className="inline-flex items-center gap-1">
                  {plugin.source === "dev" ? (
                    <Pill tone="highlight">dev</Pill>
                  ) : plugin.source === "git" ? (
                    <Pill>git</Pill>
                  ) : (
                    <Pill>local</Pill>
                  )}
                </span>
              </Field>
              <Field label="Created">{formatTime(plugin.created_at)}</Field>
              <Field label="Updated">{formatTime(plugin.updated_at)}</Field>
            </div>
            <Field label="Local path">{plugin.local_path}</Field>
            {plugin.git_url && <Field label="Git URL">{plugin.git_url}</Field>}
            {plugin.subpath && <Field label="Subpath">{plugin.subpath}</Field>}
          </Section>

          {/* Capabilities / contribution points */}
          <Section title="Capabilities">
            {c?.panel || c?.sidebar || c?.mcp || c?.backend ? (
              <div className="space-y-2">
                {c?.panel && (
                  <div className="flex items-center gap-2">
                    <Pill tone="highlight">panel</Pill>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {c.panel.title ? `“${c.panel.title}”` : "Workspace panel"}
                      {c.panel.side ? ` · ${c.panel.side}` : ""}
                    </span>
                  </div>
                )}
                {c?.sidebar && (
                  <div className="flex items-center gap-2">
                    <Pill tone="highlight">sidebar</Pill>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {c.sidebar.title ? `“${c.sidebar.title}”` : "Top-level page"}
                    </span>
                  </div>
                )}
                {c?.mcp && (
                  <div className="flex items-center gap-2">
                    <Pill tone="highlight">mcp</Pill>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      Ships an MCP server
                    </span>
                  </div>
                )}
                {c?.backend && (
                  <div className="flex items-center gap-2">
                    <Pill tone="highlight">backend</Pill>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      Ships a node backend
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">
                No contribution points declared.
              </p>
            )}
          </Section>

          {/* Permissions */}
          <Section title="Permissions">
            {plugin.permissions && plugin.permissions.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {plugin.permissions.map((perm) => {
                  const highRisk = HIGH_RISK_PERMISSIONS.has(perm);
                  return (
                    <span
                      key={perm}
                      className={
                        highRisk
                          ? "rounded-full bg-[var(--color-warning)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-warning)]"
                          : "rounded-full bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                      }
                      title={
                        highRisk
                          ? "High-risk permission — this plugin can modify your files, run commands, or drive the agent"
                          : "Declared permission"
                      }
                    >
                      {highRisk ? `⚠ ${permLabel(perm)}` : permLabel(perm)}
                    </span>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">No permissions declared.</p>
            )}
          </Section>

          {/* Status — one dense line: readiness + (if it has a server) the
              runtime command and whether it's on PATH. */}
          <Section title="Status">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-text-muted)]">
              {plugin.exists === false ? (
                <Pill tone="error">⚠ folder missing</Pill>
              ) : plugin.unbuilt && plugin.unbuilt.length > 0 ? (
                <Pill tone="warning">⚠ not built: {plugin.unbuilt.join(", ")}</Pill>
              ) : (
                <Pill tone="success">ready</Pill>
              )}
              {plugin.runtime && (
                <span>
                  runs <code className="text-[var(--color-text)]">{plugin.runtime.command}</code>
                  {plugin.runtime.available ? (
                    <span className="text-[var(--color-success)]"> · available</span>
                  ) : (
                    <span className="text-[var(--color-warning)]"> · not on PATH</span>
                  )}
                </span>
              )}
            </div>
            {plugin.exists === false && (
              <p className="text-xs text-[var(--color-error)]">
                The plugin's folder no longer exists on disk — delete this entry to clean it up.
              </p>
            )}
          </Section>

          {/* Developer tools — dev plugins only (their SDK is vendored in-folder). */}
          {plugin.source === "dev" && (
            <Section title="Developer">
              <p className="text-xs text-[var(--color-text-muted)]">
                Refresh the vendored SDK in <code>src/grove-sdk/</code> to this Grove's
                version, then rebuild. Only the SDK files change — never your code.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={onUpdateSdk}
                  disabled={sdkState === "running"}
                >
                  <RefreshCw
                    className={`mr-1.5 h-3.5 w-3.5 ${sdkState === "running" ? "animate-spin" : ""}`}
                  />
                  {sdkState === "running" ? "Updating…" : "Update SDK"}
                </Button>
                {sdkMsg && (
                  <span
                    className={`text-xs ${sdkState === "error" ? "text-[var(--color-error)]" : "text-[var(--color-success)]"}`}
                  >
                    {sdkMsg}
                  </span>
                )}
              </div>
            </Section>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
