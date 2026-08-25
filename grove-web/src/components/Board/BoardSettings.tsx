// Per-project task defaults editor, opened from the Board header gear.
// Edits the agent / opening-prompt preamble / task rules / routing rules that
// dispatch + start apply when a card is worked. Persists to
// GET/PUT /api/v1/projects/{id}/settings.

import { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";
import {
  getProjectSettings,
  updateProjectSettings,
  type ProjectSettings,
} from "../../api";
import { listInstalledAgentConfigs } from "../../api/marketplace";
import { listCustomAgents } from "../../api/customAgent";

interface BoardSettingsProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

const EMPTY: ProjectSettings = {
  default_agent: "",
  prompt_preamble: "",
  task_rules: "",
  routing_rules: "",
  default_target_branch: "",
};

interface AgentOption {
  id: string;
  label: string;
  group: "Agents" | "Personas";
}

export function BoardSettings({ projectId, projectName, onClose }: BoardSettingsProps) {
  const [settings, setSettings] = useState<ProjectSettings>(EMPTY);
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [s, agents, personas] = await Promise.all([
          getProjectSettings(projectId),
          listInstalledAgentConfigs().catch(() => []),
          listCustomAgents().catch(() => []),
        ]);
        if (!alive) return;
        setSettings({ ...EMPTY, ...s });
        const opts: AgentOption[] = [
          ...agents.map((a) => ({ id: a.id, label: a.name || a.id, group: "Agents" as const })),
          ...personas.map((p) => ({
            id: p.id,
            label: `${p.name} · ${p.base_agent}`,
            group: "Personas" as const,
          })),
        ];
        setAgentOptions(opts);
      } catch (e) {
        if (alive) setError((e as { message?: string })?.message ?? "Failed to load settings");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  const set = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await updateProjectSettings(projectId, settings);
      setSettings({ ...EMPTY, ...saved });
      onClose();
    } catch (e) {
      setError((e as { message?: string })?.message ?? "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const agents = agentOptions.filter((o) => o.group === "Agents");
  const personas = agentOptions.filter((o) => o.group === "Personas");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-bg-secondary)] rounded-t-2xl">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--color-text)]">Task defaults</h2>
            <p className="text-xs text-[var(--color-text-muted)] truncate">
              {projectName} — applied when a card is dispatched or started
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--color-text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="px-6 py-5 space-y-5">
            {/* Default agent */}
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Default agent
              </span>
              <select
                value={settings.default_agent}
                onChange={(e) => set("default_agent", e.target.value)}
                className="mt-1.5 w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)]"
              >
                <option value="">Global default</option>
                {agents.length > 0 && (
                  <optgroup label="Agents">
                    {agents.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {personas.length > 0 && (
                  <optgroup label="Personas">
                    {personas.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                Used when a dispatch/start request doesn't name an agent.
              </span>
            </label>

            {/* Default target branch */}
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Default target branch
              </span>
              <input
                type="text"
                value={settings.default_target_branch}
                onChange={(e) => set("default_target_branch", e.target.value)}
                placeholder="(project's current branch)"
                className="mt-1.5 w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)]"
              />
            </label>

            {/* Prompt preamble */}
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Opening-prompt preamble
              </span>
              <textarea
                value={settings.prompt_preamble}
                onChange={(e) => set("prompt_preamble", e.target.value)}
                rows={3}
                placeholder="Prepended before every task. The default 'investigate + commit' closing always remains."
                className="mt-1.5 w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] font-mono resize-y"
              />
            </label>

            {/* Task rules */}
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Task rules
              </span>
              <textarea
                value={settings.task_rules}
                onChange={(e) => set("task_rules", e.target.value)}
                rows={4}
                placeholder="Injected as a '## Rules' block the agent must follow (conventions, guardrails)."
                className="mt-1.5 w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] font-mono resize-y"
              />
            </label>

            {/* Routing rules */}
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Routing rules
              </span>
              <textarea
                value={settings.routing_rules}
                onChange={(e) => set("routing_rules", e.target.value)}
                rows={3}
                placeholder="Read by the nanobot file_bug classifier when routing bugs to this repo (agent / lane hints)."
                className="mt-1.5 w-full rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text)] font-mono resize-y"
              />
            </label>

            {error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--color-border)] sticky bottom-0 bg-[var(--color-bg-secondary)] rounded-b-2xl">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[var(--color-highlight)] text-white disabled:opacity-50"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
