import { useCallback, useMemo, useRef, useState } from "react";
import { Layout, Model, Actions, DockLocation, TabNode } from "flexlayout-react";
import { Plus, AlignHorizontalSpaceAround } from "lucide-react";
import "flexlayout-react/style/light.css";
import "../Tasks/PanelSystem/flexlayout-theme.css";
import { TaskChat } from "../Tasks/TaskView/TaskChat";
import { ChatPickerDropdown } from "./ChatPickerDropdown";
import type { BlitzTask } from "../../data/types";
import type { SlotAssignment } from "./useBlitzGrid";
import {
  type BlitzTabConfig,
  type OpenTab,
  buildColumnsModelJson,
  createInitialModel,
  persistModelJson,
  tabNodeFor,
} from "./blitzFlexModel";

/** Grid presets: label → number of columns to tile open chats into. */
const GRID_PRESETS: ReadonlyArray<{ label: string; cols: number; title: string }> = [
  { label: "1", cols: 1, title: "Single column" },
  { label: "2", cols: 2, title: "Two columns" },
  { label: "2×2", cols: 2, title: "Two columns (2×2 with four chats)" },
  { label: "3×2", cols: 3, title: "Three columns (3×2 with six chats)" },
];

interface BlitzFlexWorkspaceProps {
  blitzTasks: BlitzTask[];
}

/**
 * One pinned chat rendered inside a FlexLayout tab. TaskChat stays MOUNTED
 * even while disconnected so its reconnect machinery keeps running — the
 * "reconnecting" state is a non-blocking overlay, not an unmount (same fix as
 * the old GridSlot).
 */
function BlitzChatPane({ cfg, blitzTasks }: { cfg: BlitzTabConfig; blitzTasks: BlitzTask[] }) {
  const [stale, setStale] = useState(false);
  const hasConnectedRef = useRef(false);

  const live = useMemo(
    () => blitzTasks.find((bt) => bt.projectId === cfg.projectId && bt.task.id === cfg.taskId),
    [blitzTasks, cfg.projectId, cfg.taskId],
  );

  if (!cfg.chatId) {
    // needsSession placeholder — the drag-to-add session picker lands in Phase 2.
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        Pick a session…
      </div>
    );
  }

  if (!live) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        Chat unavailable
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0 overflow-hidden">
      {/* Context breadcrumb — which project · task · chat this panel is, since
          the tab only shows the chat name and several panels coexist. */}
      <div className="flex items-center gap-1 shrink-0 px-2.5 py-1 text-[11px] leading-none border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
        <span className="shrink-0 text-[var(--color-text-muted)]">{cfg.projectName}</span>
        <span className="shrink-0 text-[var(--color-text-muted)]">·</span>
        <span className="truncate min-w-0 text-[var(--color-text)]">{cfg.taskName}</span>
        <span className="shrink-0 text-[var(--color-text-muted)]">·</span>
        <span className="truncate min-w-0 text-[var(--color-highlight)]">{cfg.chatName}</span>
      </div>
      <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <TaskChat
          projectId={live.projectId}
          task={live.task}
          pinnedChatId={cfg.chatId}
          hideHeader={true}
          onConnected={() => {
            hasConnectedRef.current = true;
            setStale(false);
          }}
          onDisconnected={() => {
            // Only flag stale after a successful connect — the initial WS setup
            // fires onDisconnected before onConnected.
            if (hasConnectedRef.current) setStale(true);
          }}
        />
        {stale && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-bg)]/80 text-sm text-[var(--color-text-muted)] pointer-events-none">
            Connection lost — reconnecting automatically…
          </div>
        )}
      </div>
    </div>
  );
}

function countTabs(m: Model): number {
  let n = 0;
  m.visitNodes((node) => {
    if (node.getType() === "tab") n += 1;
  });
  return n;
}

/**
 * Blitz grid rebuilt on flexlayout-react: each pinned chat is a tab/panel you
 * can split, resize, rearrange, add, and close — replacing the fixed
 * 1/2/2×2/3×2 presets. Layout (and which chats are pinned where) persists to
 * localStorage; existing preset grids migrate in on first load.
 */
export function BlitzFlexWorkspace({ blitzTasks }: BlitzFlexWorkspaceProps) {
  const [model, setModel] = useState(() => createInitialModel());
  const [isEmpty, setIsEmpty] = useState(() => countTabs(model) === 0);
  const [pickerOpen, setPickerOpen] = useState(false);

  const collectTabs = useCallback((): OpenTab[] => {
    const tabs: OpenTab[] = [];
    model.visitNodes((node) => {
      if (node.getType() === "tab") {
        tabs.push({ id: node.getId(), config: (node as TabNode).getConfig() as BlitzTabConfig });
      }
    });
    return tabs;
  }, [model]);

  // Reset every panel to equal size in place (no reshape, no remount → chats
  // stay connected). adjustWeights on each multi-child row evens columns and,
  // via nested rows, the stacked panels within them.
  const equalize = useCallback(() => {
    const rows: Array<{ id: string; count: number }> = [];
    model.visitNodes((node) => {
      if (node.getType() === "row") {
        const count = node.getChildren().length;
        if (count > 1) rows.push({ id: node.getId(), count });
      }
    });
    rows.forEach(({ id, count }) =>
      model.doAction(Actions.adjustWeights(id, new Array(count).fill(100))),
    );
  }, [model]);

  // Snap open chats into an even grid of `cols` columns (the optional
  // "auto grid"). Tab ids are preserved so panels reconcile instead of
  // remounting — connections survive the re-tile.
  const tileColumns = useCallback(
    (cols: number) => {
      const tabs = collectTabs();
      if (tabs.length === 0) return;
      const json = buildColumnsModelJson(tabs, cols);
      setModel(Model.fromJson(json));
      persistModelJson(json);
      setIsEmpty(false);
    },
    [collectTabs],
  );

  const factory = useCallback(
    (node: TabNode) => <BlitzChatPane cfg={node.getConfig() as BlitzTabConfig} blitzTasks={blitzTasks} />,
    [blitzTasks],
  );

  const handleModelChange = useCallback((m: Model) => {
    persistModelJson(m.toJson());
    setIsEmpty(countTabs(m) === 0);
  }, []);

  const addChat = useCallback(
    (a: SlotAssignment) => {
      setPickerOpen(false);
      // Already pinned somewhere? Select that tab instead of adding a duplicate.
      const tabs: TabNode[] = [];
      model.visitNodes((node) => {
        if (node.getType() === "tab") tabs.push(node as TabNode);
      });
      const existing = tabs.find(
        (t) => (t.getConfig() as BlitzTabConfig | undefined)?.chatId === a.chatId,
      );
      if (existing) {
        model.doAction(Actions.selectTab(existing.getId()));
        return;
      }
      const cfg: BlitzTabConfig = {
        projectId: a.projectId,
        projectName: a.projectName,
        taskId: a.taskId,
        taskName: a.taskName,
        chatId: a.chatId,
        chatName: a.chatName,
      };
      const active = model.getActiveTabset();
      const targetId = active?.getId() ?? model.getRoot().getId();
      model.doAction(Actions.addNode(tabNodeFor(cfg), targetId, DockLocation.CENTER, -1));
      // handleModelChange fires from the action → persists + clears empty state.
    },
    [model],
  );

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={equalize}
            disabled={isEmpty}
            title="Reset all panel sizes to equal"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            <AlignHorizontalSpaceAround className="w-3.5 h-3.5" />
            Equalize
          </button>
          <div className="flex items-center rounded-lg border border-[var(--color-border)] overflow-hidden text-xs">
            <span className="px-2 py-1.5 text-[var(--color-text-muted)] border-r border-[var(--color-border)]">
              Grid
            </span>
            {GRID_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => tileColumns(p.cols)}
                disabled={isEmpty}
                title={p.title}
                className="px-2.5 py-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/10 disabled:opacity-40 disabled:pointer-events-none transition-colors border-l border-[var(--color-border)] first:border-l-0"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/20 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add chat
          </button>
          {pickerOpen && (
            <ChatPickerDropdown
              blitzTasks={blitzTasks}
              onSelect={addChat}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0">
          <Layout model={model} factory={factory} onModelChange={handleModelChange} />
        </div>
        {isEmpty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 pointer-events-none text-[var(--color-text-muted)]">
            <span className="text-sm">No chats pinned yet</span>
            <span className="text-xs text-[var(--color-text-faint,var(--color-text-muted))]">
              Use “Add chat” to pin a session as a panel
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
