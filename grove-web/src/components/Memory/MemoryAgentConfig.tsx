import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { Box, Brain, Check, ChevronDown, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { AgentConfigSelection } from "../../api/automations";
import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectValue,
} from "../../api/tasks";
import {
  configCategoryMatches,
  flattenConfigValues,
  isConfigGroup,
  quickConfigOptions,
} from "../Tasks/TaskView/sessionConfigOptions";

type ConfigSelection = Extract<AgentConfigSelection, { source: "config_options" }>;

interface MemoryAgentConfigProps {
  options: SessionConfigOption[];
  config: ConfigSelection;
  onChange: (config: AgentConfigSelection) => void;
}

export function MemoryAgentConfig({ options, config, onChange }: MemoryAgentConfigProps) {
  const quick = quickConfigOptions(options);
  const quickOptions = [quick.model, quick.mode, quick.thinking].filter(
    (option): option is SessionConfigOption => Boolean(option),
  );
  const quickIds = new Set(quickOptions.map((option) => option.id));
  const additional = options.filter((option) => !quickIds.has(option.id));

  const selectedValue = (option: SessionConfigOption) =>
    config.values[option.id] ?? option.currentValue;
  const select = (option: SessionConfigOption, value: string | boolean) =>
    onChange({ ...config, values: { ...config.values, [option.id]: value } });

  return (
    <div className="flex min-h-7 flex-wrap items-center gap-1">
      {quickOptions.map((option) => (
        <QuickConfigPill
          key={option.id}
          option={option}
          value={selectedValue(option)}
          onChange={(value) => select(option, value)}
        />
      ))}
      {additional.length > 0 && (
        <AdditionalConfigMenu
          options={additional}
          selectedValue={selectedValue}
          onChange={select}
        />
      )}
    </div>
  );
}


function QuickConfigPill({ option, value, onChange }: { option: SessionConfigOption; value: string | boolean; onChange: (value: string | boolean) => void }) {
  const { open, anchor, triggerRef, menuRef, close, toggle } = useConfigPopover(240, 300);
  const values = option.type === "select" ? flattenConfigValues(option) : [];
  const currentLabel = option.type === "boolean"
    ? value ? "On" : "Off"
    : values.find((item) => item.value === value)?.name ?? String(value);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex h-7 items-center gap-1 rounded-full bg-[var(--color-bg)] px-2 text-[10.5px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
      >
        {iconForOption(option)}
        <span className="opacity-70">{option.name}</span>
        <span className="max-w-40 truncate text-[var(--color-text)]">{currentLabel}</span>
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && anchor && createPortal(
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, y: anchor.opensUp ? 6 : -6 }}
          animate={{ opacity: 1, y: 0 }}
          style={popoverStyle(anchor)}
          className="z-[1000] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-1.5 shadow-lg"
        >
          <div className="px-2 pb-1.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{option.name}</div>
          {option.type === "boolean" ? (
            <button type="button" onClick={() => { onChange(!value); close(); }} className="flex w-full items-center justify-between rounded-md px-2 py-2 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]">
              <span>{value ? "On" : "Off"}</span><MiniSwitch value={Boolean(value)} />
            </button>
          ) : option.options.some(isConfigGroup) ? (
            (option.options as SessionConfigSelectGroup[]).map((group) => (
              <div key={group.group}>
                <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{group.name}</div>
                {group.options.map((item) => <ConfigValueButton key={item.value} item={item} selected={item.value === value} onClick={() => { onChange(item.value); close(); }} />)}
              </div>
            ))
          ) : (
            (option.options as SessionConfigSelectValue[]).map((item) => <ConfigValueButton key={item.value} item={item} selected={item.value === value} onClick={() => { onChange(item.value); close(); }} />)
          )}
        </motion.div>,
        document.body,
      )}
    </div>
  );
}

function AdditionalConfigMenu({ options, selectedValue, onChange }: { options: SessionConfigOption[]; selectedValue: (option: SessionConfigOption) => string | boolean; onChange: (option: SessionConfigOption, value: string | boolean) => void }) {
  const { open, anchor, triggerRef, menuRef, toggle } = useConfigPopover(320, 360);
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        title="Agent settings"
        aria-label="Agent settings"
        aria-expanded={open}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-bg)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && anchor && createPortal(
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, y: anchor.opensUp ? 6 : -6 }}
          animate={{ opacity: 1, y: 0 }}
          style={popoverStyle(anchor)}
          className="z-[1000] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-1.5 shadow-lg"
        >
          {options.map((option) => {
            const value = selectedValue(option);
            return (
              <div key={option.id} className="border-b border-[var(--color-border)] px-1 py-2 last:border-b-0">
                <div className="mb-1 grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2 px-1">
                  <span className="mt-0.5 text-[var(--color-text-muted)]">{iconForOption(option)}</span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-[var(--color-text)]">{option.name}</span>
                    {option.description && <span className="mt-0.5 block text-[10px] leading-4 text-[var(--color-text-muted)]">{option.description}</span>}
                  </span>
                </div>
                {option.type === "boolean" ? (
                  <button type="button" role="switch" aria-checked={Boolean(value)} onClick={() => onChange(option, !value)} className="mt-1 grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1 py-1.5 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]">
                    <span aria-hidden="true" /><span>{value ? "On" : "Off"}</span><MiniSwitch value={Boolean(value)} />
                  </button>
                ) : option.options.some(isConfigGroup) ? (
                  (option.options as SessionConfigSelectGroup[]).map((group) => (
                    <div key={group.group} className="mt-1">
                      <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2 px-1 py-1"><span /><span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{group.name}</span></div>
                      {group.options.map((item) => <ConfigValueButton key={item.value} item={item} selected={item.value === value} indented onClick={() => onChange(option, item.value)} />)}
                    </div>
                  ))
                ) : (
                  (option.options as SessionConfigSelectValue[]).map((item) => <ConfigValueButton key={item.value} item={item} selected={item.value === value} indented onClick={() => onChange(option, item.value)} />)
                )}
              </div>
            );
          })}
        </motion.div>,
        document.body,
      )}
    </div>
  );
}

function ConfigValueButton({ item, selected, onClick, indented = false }: { item: SessionConfigSelectValue; selected: boolean; onClick: () => void; indented?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={`grid w-full ${indented ? "grid-cols-[14px_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]"} items-start gap-x-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-bg-tertiary)]`}>
      {indented && <span aria-hidden="true" />}
      <span className="min-w-0"><span className="block text-xs text-[var(--color-text)]">{item.name}</span>{item.description && <span className="mt-0.5 block text-[10px] leading-4 text-[var(--color-text-muted)]">{item.description}</span>}</span>
      {selected && <Check className="mt-0.5 h-3.5 w-3.5 text-[var(--color-highlight)]" />}
    </button>
  );
}

function MiniSwitch({ value }: { value: boolean }) {
  return <span className={`relative inline-block h-4 w-7 justify-self-end rounded-full transition-colors ${value ? "bg-[var(--color-highlight)]" : "bg-[var(--color-bg-tertiary)]"}`}><span className={`absolute top-0.5 block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${value ? "translate-x-3.5" : "translate-x-0.5"}`} /></span>;
}

function iconForOption(option: SessionConfigOption): ReactNode {
  if (configCategoryMatches(option, "model")) return <Box className="h-3.5 w-3.5" />;
  if (configCategoryMatches(option, "mode")) return <ShieldCheck className="h-3.5 w-3.5" />;
  if (configCategoryMatches(option, "thought_level")) return <Brain className="h-3.5 w-3.5" />;
  return <SlidersHorizontal className="h-3.5 w-3.5" />;
}

interface ConfigPopoverAnchor {
  top: number | null;
  bottom: number | null;
  left: number;
  width: number;
  maxHeight: number;
  opensUp: boolean;
}

function useConfigPopover(width: number, preferredHeight: number) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<ConfigPopoverAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const position = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const availableBelow = window.innerHeight - rect.bottom - gap - margin;
    const availableAbove = rect.top - gap - margin;
    const opensUp = availableBelow < Math.min(180, preferredHeight) && availableAbove > availableBelow;
    setAnchor({
      top: opensUp ? null : rect.bottom + gap,
      bottom: opensUp ? window.innerHeight - rect.top + gap : null,
      left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
      width,
      maxHeight: Math.max(120, Math.min(preferredHeight, opensUp ? availableAbove : availableBelow)),
      opensUp,
    });
  }, [preferredHeight, width]);
  const toggle = () => {
    if (!open) position();
    setOpen((value) => !value);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    position();
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [close, open, position]);

  return { open, anchor, triggerRef, menuRef, close, toggle };
}

function popoverStyle(anchor: ConfigPopoverAnchor): React.CSSProperties {
  return {
    position: "fixed",
    top: anchor.top ?? undefined,
    bottom: anchor.bottom ?? undefined,
    left: anchor.left,
    width: anchor.width,
    maxHeight: anchor.maxHeight,
  };
}
