import { useCallback, useMemo, useRef, useState } from "react";
import { Layout, Model, Actions, DockLocation, TabNode } from "flexlayout-react";
import { Plus } from "lucide-react";
import "flexlayout-react/style/light.css";
import "../Tasks/PanelSystem/flexlayout-theme.css";
import { TaskChat } from "../Tasks/TaskView/TaskChat";
import { ChatPickerDropdown } from "./ChatPickerDropdown";
import type { BlitzTask } from "../../data/types";
import type { SlotAssignment } from "./useBlitzGrid";
import {
  type BlitzTabConfig,
  createInitialModel,
  persistModelJson,
  tabNodeFor,
} from "./blitzFlexModel";

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
    <div className="relative flex h-full w-full min-h-0 min-w-0 overflow-hidden">
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
  const [model] = useState(() => createInitialModel());
  const [isEmpty, setIsEmpty] = useState(() => countTabs(model) === 0);
  const [pickerOpen, setPickerOpen] = useState(false);

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
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)]">
        <span className="text-xs text-[var(--color-text-muted)]">
          Workspace · drag tabs to rearrange, drag edges to resize
        </span>
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
