# Blitz Grid Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **User directive: add a Codex review pass after the existing 2-stage Claude review on each task.** Three-stage review per task:
> 1. Claude spec compliance reviewer (existing)
> 2. Claude code quality reviewer (existing)
> 3. **Codex independent review** (NEW — via `codex:rescue` agent with the per-task diff). Surface issues to the implementer to address before marking task complete.

**Goal:** Add an opt-in grid view in Blitz mode that hosts up to 6 chat conversations simultaneously, switchable via Cmd+G or a toolbar button.

**Architecture:** Hand-rolled CSS Grid in a new `BlitzGridWorkspace` component, hosting `N` `GridSlot` components that each wrap one `TaskChat` instance pinned to a specific chat. Slot assignments + layout preset persist to localStorage. No backend changes. Requires one small additive prop on `TaskChat` (`pinnedChatId`) so a slot can lock to a single chat.

**Tech Stack:** React 19, TypeScript 5.9, Tailwind CSS 4, existing `apiClient` for `listChats(projectId, taskId)`, existing `useBlitzTasks` hook for cross-project task list.

**Spec:** `docs/superpowers/specs/2026-05-29-blitz-grid-workspace-design.md`

**Branch:** `blitz/grid-workspace` (already created off `master`, with spec commit `ae74da4`).

---

## Pre-flight assumptions

- `pnpm` is on PATH (verify with `which pnpm` if uncertain — STOP and report BLOCKED if missing).
- `grove-web/` builds clean on `master` (verify with `cd grove-web && pnpm run build` once before Task 1).
- Branch `blitz/grid-workspace` is checked out with current HEAD `ae74da4` (the spec commit).
- ESLint runs clean on `master` (`cd grove-web && pnpm eslint src/ --max-warnings 0`).

## File structure summary

| File | Status | Responsibility |
|---|---|---|
| `grove-web/src/components/Tasks/TaskView/TaskChat.tsx` | modify | Add `pinnedChatId?: string` prop; when provided, init `activeChatId` from it and hide the chat-switcher tab UI. |
| `grove-web/src/components/Blitz/useBlitzGrid.ts` | new | Hook owning layout + slot assignments + localStorage persistence. |
| `grove-web/src/components/Blitz/GridLayoutToolbar.tsx` | new | Preset button row (1, 2, 2×2, 3×2). |
| `grove-web/src/components/Blitz/ChatPickerDropdown.tsx` | new | Two-level picker — tasks (grouped by project) → expand to show chats → click to select. |
| `grove-web/src/components/Blitz/EmptyGridSlot.tsx` | new | "+ pick a chat" placeholder; opens picker. |
| `grove-web/src/components/Blitz/GridSlot.tsx` | new | Slot router — empty placeholder OR title bar + `TaskChat` (pinned to a chat). Handles stale-chat overlay. |
| `grove-web/src/components/Blitz/BlitzGridWorkspace.tsx` | new | Top-level grid view — layout toolbar + CSS Grid of slots. Owns shrink-confirm modal. |
| `grove-web/src/components/Blitz/BlitzPage.tsx` | modify | Add `gridMode` state, Cmd+G shortcut, "Grid view" toolbar button. Conditional render. |
| `grove-web/src/components/Blitz/index.ts` | modify | Re-export new components if needed (follow existing pattern). |

**Total:** ~660 LOC across 9 files. No backend changes. No new dependencies.

## Commit map

| Commit | Task | Files |
|---|---|---|
| 1 | Add `pinnedChatId` to TaskChat | `TaskChat.tsx` |
| 2 | useBlitzGrid hook | `useBlitzGrid.ts` |
| 3 | GridLayoutToolbar | `GridLayoutToolbar.tsx`, `index.ts` |
| 4 | ChatPickerDropdown | `ChatPickerDropdown.tsx` |
| 5 | EmptyGridSlot | `EmptyGridSlot.tsx` |
| 6 | GridSlot | `GridSlot.tsx` |
| 7 | BlitzGridWorkspace | `BlitzGridWorkspace.tsx` |
| 8 | BlitzPage integration | `BlitzPage.tsx` |
| 9 | (manual verification only — no commit) | none |

---

## Task 1: Add `pinnedChatId` prop to TaskChat

**Files:**
- Modify: `grove-web/src/components/Tasks/TaskView/TaskChat.tsx`

**Rationale:** The grid spec requires each slot to host exactly one chat. TaskChat today owns its `activeChatId` state internally (loaded from `listChats` on mount, defaulting to most recent). To pin a slot to a specific chat we need an external prop. Additive — when `pinnedChatId` is omitted, behavior is unchanged (preserves Zen mode + single-task workspace).

**Risk:** TaskChat is ~7000 LOC and is the hot path. The change must be additive only — do NOT refactor anything else.

- [ ] **Step 1.1: Pre-flight build check**

  Run: `cd grove-web && pnpm run build 2>&1 | tail -3`

  Expected: `✓ built in NmNNs`. If it fails on `master`, STOP and report BLOCKED.

- [ ] **Step 1.2: Read the TaskChat props interface**

  Run: `sed -n '238,265p' grove-web/src/components/Tasks/TaskView/TaskChat.tsx`

  Confirm: lines 238-265 contain `interface TaskChatProps { projectId: string; task: Task; ... }` plus optional callback props.

- [ ] **Step 1.3: Add the prop to the interface**

  In `grove-web/src/components/Tasks/TaskView/TaskChat.tsx`, find:
  ```ts
  interface TaskChatProps {
    projectId: string;
    task: Task;
    collapsed?: boolean;
  ```

  Insert immediately after the `task: Task;` line:
  ```ts
    /** If provided, the chat with this id is pinned as the active chat
     *  and the chat-switcher tab UI is hidden. Used by the Blitz grid
     *  workspace to scope each slot to a single chat. Omitted in Zen
     *  mode and the single-task Blitz workspace (preserves existing
     *  multi-chat tab behavior). */
    pinnedChatId?: string;
  ```

- [ ] **Step 1.4: Accept the prop in the component**

  Find the export at line ~1649: `export function TaskChat({`. Add `pinnedChatId,` to the destructured arg list — keep alphabetical placement if the existing destructure is alphabetical, otherwise add immediately after `task`.

  Example destructure addition:
  ```ts
  export function TaskChat({
    projectId,
    task,
    pinnedChatId,
    collapsed,
    onExpand,
    // ... rest unchanged
  }: TaskChatProps) {
  ```

- [ ] **Step 1.5: Use `pinnedChatId` as the initial active chat**

  Find the `activeChatId` state initialization in TaskChat (search for `useState<string | null>(` near the top of the component body — the activeChatId state hook).

  Run: `grep -n "useState<string | null>" grove-web/src/components/Tasks/TaskView/TaskChat.tsx | head -5`

  Identify the line that initializes `activeChatId`. It will look like one of:
  ```ts
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  ```
  or possibly with a function initializer.

  Modify to seed from `pinnedChatId` when present:
  ```ts
  const [activeChatId, setActiveChatId] = useState<string | null>(pinnedChatId ?? null);
  ```

  If the initializer is more complex (e.g., already reads from storage or props), instead add `pinnedChatId ?? ` as the first fallback in the resolution chain. The intent: when `pinnedChatId` is set, that wins.

- [ ] **Step 1.6: Lock the active chat to `pinnedChatId` once chats load**

  TaskChat's existing logic loads `chats` from `listChats` and may auto-set `activeChatId` to the first/most-recent. We need to prevent that override when `pinnedChatId` is set.

  Find the effect or callback that sets `activeChatId` from the loaded chats list. Look for the pattern: `setActiveChatId(...)` calls inside a `useEffect` triggered by `chats` updates, OR inside a callback that fires after `listChats` returns.

  Run: `grep -n "setActiveChatId(" grove-web/src/components/Tasks/TaskView/TaskChat.tsx | head -10`

  At each `setActiveChatId(...)` call that is NOT in response to an explicit user tab-click, wrap with a guard:
  ```ts
  if (!pinnedChatId) {
    setActiveChatId(/* existing value */);
  }
  ```

  If the call IS in response to an explicit user tab-click (e.g., inside a tab button's `onClick`), leave it as-is — when `pinnedChatId` is set, the tab UI is hidden in Step 1.7 anyway so those handlers can't fire.

  **If uncertain about a specific call site:** report DONE_WITH_CONCERNS listing the ambiguous sites; the controller will dispatch a targeted clarification.

- [ ] **Step 1.7: Hide the chat-switcher tab strip when `pinnedChatId` is set**

  Find the JSX that renders the chat tab strip (search for `chats.map(` near the JSX return).

  Run: `grep -n "chats\.map\|ChatTab\|TabStrip" grove-web/src/components/Tasks/TaskView/TaskChat.tsx | head -8`

  Wrap the rendering with a conditional:
  ```tsx
  {!pinnedChatId && (
    <div className="...">
      {chats.map(...)}
    </div>
  )}
  ```

  Preserve the existing className and surrounding structure exactly.

- [ ] **Step 1.8: Type-check and build**

  Run: `cd grove-web && pnpm run build 2>&1 | tail -5`

  Expected: `✓ built in NmNNs`, no TypeScript errors. If type errors appear, fix them in TaskChat (most likely a `pinnedChatId` reference inside a function before its destructure — re-check Step 1.4 placement).

- [ ] **Step 1.9: ESLint check**

  Run: `cd grove-web && pnpm eslint src/components/Tasks/TaskView/TaskChat.tsx --max-warnings 0 2>&1 | tail -5`

  Expected: no errors, no warnings. If lint flags `pinnedChatId` unused, you missed one of Steps 1.5/1.6/1.7.

- [ ] **Step 1.10: Manual smoke (Zen mode still works)**

  Skip if you don't have a Grove server running. If you do:
  - Run: `cargo build && ./target/debug/grove web --port 3052 --no-open` (background)
  - Open `http://localhost:3052`, enter a task in Zen mode, confirm the chat-switcher tabs still appear and switching chats still works.
  - Kill the server.

  This catches regressions in the un-pinned path before the grid feature exercises the pinned path.

- [ ] **Step 1.11: Commit**

  Run (from repo root):
  ```
  git add grove-web/src/components/Tasks/TaskView/TaskChat.tsx
  git commit -m "$(cat <<'EOF'
  feat(taskchat): add optional pinnedChatId prop

  When provided, TaskChat pins to the given chat as active and hides
  the chat-switcher tab strip. Additive — omitting the prop preserves
  the existing multi-chat tab behavior used by Zen mode and the
  single-task Blitz workspace.

  Foundation for the Blitz grid workspace feature, where each slot
  must lock to a single chat (per docs/superpowers/specs/2026-05-29-
  blitz-grid-workspace-design.md).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 2: useBlitzGrid hook

**Files:**
- Create: `grove-web/src/components/Blitz/useBlitzGrid.ts`

**Rationale:** Single source of truth for grid state (layout preset, slot assignments) with localStorage persistence. Pure logic — no React rendering concerns. Other components consume `{ layout, setLayout, assignments, assign, clearSlot }`.

- [ ] **Step 2.1: Create the file**

  Write `grove-web/src/components/Blitz/useBlitzGrid.ts` with exact contents:

  ```ts
  import { useState, useCallback, useEffect, useRef } from "react";

  export type GridLayout = "1" | "2" | "2x2" | "3x2";

  export const GRID_LAYOUTS: ReadonlyArray<GridLayout> = ["1", "2", "2x2", "3x2"];

  export function slotCountFor(layout: GridLayout): number {
    switch (layout) {
      case "1": return 1;
      case "2": return 2;
      case "2x2": return 4;
      case "3x2": return 6;
    }
  }

  export interface SlotAssignment {
    projectId: string;
    projectName: string;
    taskId: string;
    taskName: string;
    chatId: string;
    chatName: string;
  }

  export interface BlitzGridState {
    version: 1;
    layout: GridLayout;
    assignments: Array<SlotAssignment | null>;
  }

  const STORAGE_KEY = "grove:blitz-grid";
  const DEFAULT_LAYOUT: GridLayout = "2x2";
  const PERSIST_DEBOUNCE_MS = 200;

  function defaultState(): BlitzGridState {
    return {
      version: 1,
      layout: DEFAULT_LAYOUT,
      assignments: new Array(slotCountFor(DEFAULT_LAYOUT)).fill(null),
    };
  }

  function hydrate(): BlitzGridState {
    if (typeof window === "undefined") return defaultState();
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return defaultState();
    }
    if (!raw) return defaultState();
    try {
      const parsed = JSON.parse(raw) as Partial<BlitzGridState>;
      const layout: GridLayout =
        typeof parsed.layout === "string" && (GRID_LAYOUTS as readonly string[]).includes(parsed.layout)
          ? (parsed.layout as GridLayout)
          : DEFAULT_LAYOUT;
      const expectedCount = slotCountFor(layout);
      const rawAssignments = Array.isArray(parsed.assignments) ? parsed.assignments : [];
      const assignments: Array<SlotAssignment | null> = new Array(expectedCount)
        .fill(null)
        .map((_, i) => {
          const a = rawAssignments[i];
          if (
            a &&
            typeof a === "object" &&
            typeof (a as SlotAssignment).projectId === "string" &&
            typeof (a as SlotAssignment).taskId === "string" &&
            typeof (a as SlotAssignment).chatId === "string"
          ) {
            return a as SlotAssignment;
          }
          return null;
        });
      return { version: 1, layout, assignments };
    } catch {
      return defaultState();
    }
  }

  export interface UseBlitzGridResult {
    layout: GridLayout;
    assignments: Array<SlotAssignment | null>;
    setLayout: (next: GridLayout) => void;
    assign: (slotIdx: number, assignment: SlotAssignment) => void;
    clearSlot: (slotIdx: number) => void;
  }

  export function useBlitzGrid(): UseBlitzGridResult {
    const [state, setState] = useState<BlitzGridState>(hydrate);
    const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
      }
      persistTimerRef.current = setTimeout(() => {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (err) {
          console.warn("[useBlitzGrid] localStorage write failed", err);
        }
      }, PERSIST_DEBOUNCE_MS);
      return () => {
        if (persistTimerRef.current !== null) {
          clearTimeout(persistTimerRef.current);
        }
      };
    }, [state]);

    const setLayout = useCallback((next: GridLayout) => {
      setState((prev) => {
        const nextCount = slotCountFor(next);
        const nextAssignments = new Array<SlotAssignment | null>(nextCount).fill(null);
        for (let i = 0; i < Math.min(prev.assignments.length, nextCount); i++) {
          nextAssignments[i] = prev.assignments[i];
        }
        return { ...prev, layout: next, assignments: nextAssignments };
      });
    }, []);

    const assign = useCallback((slotIdx: number, assignment: SlotAssignment) => {
      setState((prev) => {
        if (slotIdx < 0 || slotIdx >= prev.assignments.length) return prev;
        const nextAssignments = prev.assignments.slice();
        nextAssignments[slotIdx] = assignment;
        return { ...prev, assignments: nextAssignments };
      });
    }, []);

    const clearSlot = useCallback((slotIdx: number) => {
      setState((prev) => {
        if (slotIdx < 0 || slotIdx >= prev.assignments.length) return prev;
        const nextAssignments = prev.assignments.slice();
        nextAssignments[slotIdx] = null;
        return { ...prev, assignments: nextAssignments };
      });
    }, []);

    return {
      layout: state.layout,
      assignments: state.assignments,
      setLayout,
      assign,
      clearSlot,
    };
  }
  ```

- [ ] **Step 2.2: Type-check and lint**

  Run: `cd grove-web && pnpm run build 2>&1 | tail -3 && pnpm eslint src/components/Blitz/useBlitzGrid.ts --max-warnings 0 2>&1 | tail -3`

  Expected: clean build, no lint output.

- [ ] **Step 2.3: Commit**

  Run:
  ```
  git add grove-web/src/components/Blitz/useBlitzGrid.ts
  git commit -m "$(cat <<'EOF'
  feat(blitz): add useBlitzGrid hook for grid state + persistence

  Owns layout preset (1, 2, 2x2, 3x2) and slot assignments. Persists
  to localStorage["grove:blitz-grid"] with a 200ms debounce. Hydrates
  on mount with whitelist validation on the layout preset and shape
  checks on each assignment — corrupt payload falls back silently to
  default state.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 3: GridLayoutToolbar

**Files:**
- Create: `grove-web/src/components/Blitz/GridLayoutToolbar.tsx`
- Modify: `grove-web/src/components/Blitz/index.ts` (only if it currently re-exports — check first)

**Rationale:** Pure presentational button row for the layout presets. Receives `current` + `onChange`, no internal state.

- [ ] **Step 3.1: Inspect existing index.ts pattern**

  Run: `cat grove-web/src/components/Blitz/index.ts`

  If it re-exports things, follow that pattern. If it's empty or only has a few exports, you can leave it alone — components are imported directly by path in this codebase.

- [ ] **Step 3.2: Create the file**

  Write `grove-web/src/components/Blitz/GridLayoutToolbar.tsx`:

  ```tsx
  import type { GridLayout } from "./useBlitzGrid";
  import { GRID_LAYOUTS } from "./useBlitzGrid";

  const LABELS: Record<GridLayout, string> = {
    "1": "1",
    "2": "2",
    "2x2": "2×2",
    "3x2": "3×2",
  };

  interface GridLayoutToolbarProps {
    current: GridLayout;
    onChange: (next: GridLayout) => void;
  }

  export function GridLayoutToolbar({ current, onChange }: GridLayoutToolbarProps) {
    return (
      <div
        role="toolbar"
        aria-label="Grid layout"
        className="flex items-center gap-1 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
      >
        <span className="text-xs text-[var(--color-text-muted)] mr-2">Layout</span>
        {GRID_LAYOUTS.map((preset) => {
          const active = preset === current;
          return (
            <button
              key={preset}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(preset)}
              className={[
                "px-2.5 py-1 text-xs rounded-md transition-colors",
                active
                  ? "bg-[var(--color-accent)] text-[var(--color-bg)] font-semibold"
                  : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]",
              ].join(" ")}
            >
              {LABELS[preset]}
            </button>
          );
        })}
      </div>
    );
  }
  ```

- [ ] **Step 3.3: Build and lint**

  Run: `cd grove-web && pnpm run build 2>&1 | tail -3 && pnpm eslint src/components/Blitz/GridLayoutToolbar.tsx --max-warnings 0 2>&1 | tail -3`

  Expected: clean.

  **Note on CSS vars:** if the build complains about unknown CSS variables, that means the theme doesn't expose `--color-accent` or `--color-bg-hover` etc. Replace them with the closest existing variables — grep for `var(--color-` in nearby components to see what's available. Do NOT introduce hardcoded colors.

- [ ] **Step 3.4: Commit**

  ```
  git add grove-web/src/components/Blitz/GridLayoutToolbar.tsx
  git commit -m "$(cat <<'EOF'
  feat(blitz): add GridLayoutToolbar preset button row

  Pure presentational row of 4 preset buttons (1, 2, 2×2, 3×2) for
  selecting the grid workspace layout. Theme-var styled, ARIA-pressed
  for the active preset.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 4: ChatPickerDropdown

**Files:**
- Create: `grove-web/src/components/Blitz/ChatPickerDropdown.tsx`

**Rationale:** Two-level picker — tasks (grouped by project) → expand to show chats → click to select. Reuses `blitzTasks` already loaded by BlitzPage (passed as a prop); lazy-fetches chats per-task via `listChats(projectId, taskId)`.

- [ ] **Step 4.1: Inspect `BlitzTask` type and `listChats` shape**

  Run:
  ```
  grep -n "BlitzTask\|ChatSessionResponse" grove-web/src/data/types.ts | head -5
  grep -A4 "interface ChatSessionResponse" grove-web/src/api/tasks.ts | head -20
  ```

  Confirm: `BlitzTask` has `{ task, projectId, projectName, projectType }`. `ChatSessionResponse` has at least `{ id, name }` (or `title` / similar — note the actual field names for the picker output).

- [ ] **Step 4.2: Create the file**

  Write `grove-web/src/components/Blitz/ChatPickerDropdown.tsx`:

  ```tsx
  import { useState, useEffect, useMemo, useRef } from "react";
  import { listChats } from "../../api/tasks";
  import type { BlitzTask } from "../../data/types";
  import type { SlotAssignment } from "./useBlitzGrid";

  interface ChatPickerDropdownProps {
    blitzTasks: BlitzTask[];
    onSelect: (assignment: SlotAssignment) => void;
    onClose: () => void;
  }

  type ChatRow = { id: string; name: string };
  type ChatLoadState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "loaded"; chats: ChatRow[] }
    | { kind: "error"; message: string };

  export function ChatPickerDropdown({ blitzTasks, onSelect, onClose }: ChatPickerDropdownProps) {
    const [query, setQuery] = useState("");
    const [expandedTaskKey, setExpandedTaskKey] = useState<string | null>(null);
    const [chatLoads, setChatLoads] = useState<Record<string, ChatLoadState>>({});
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      inputRef.current?.focus();
    }, []);

    useEffect(() => {
      function onDocClick(e: MouseEvent) {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          onClose();
        }
      }
      function onKey(e: KeyboardEvent) {
        if (e.key === "Escape") onClose();
      }
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onDocClick);
        document.removeEventListener("keydown", onKey);
      };
    }, [onClose]);

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) return blitzTasks;
      return blitzTasks.filter((bt) => bt.task.name.toLowerCase().includes(q));
    }, [blitzTasks, query]);

    const grouped = useMemo(() => {
      const m = new Map<string, { projectId: string; projectName: string; tasks: BlitzTask[] }>();
      for (const bt of filtered) {
        const g = m.get(bt.projectId);
        if (g) g.tasks.push(bt);
        else m.set(bt.projectId, { projectId: bt.projectId, projectName: bt.projectName, tasks: [bt] });
      }
      return Array.from(m.values());
    }, [filtered]);

    function taskKey(bt: BlitzTask): string {
      return `${bt.projectId}:${bt.task.id}`;
    }

    async function toggleExpand(bt: BlitzTask) {
      const key = taskKey(bt);
      if (expandedTaskKey === key) {
        setExpandedTaskKey(null);
        return;
      }
      setExpandedTaskKey(key);
      const existing = chatLoads[key];
      if (existing && existing.kind !== "idle" && existing.kind !== "error") return;
      setChatLoads((prev) => ({ ...prev, [key]: { kind: "loading" } }));
      try {
        const chats = await listChats(bt.projectId, bt.task.id);
        setChatLoads((prev) => ({
          ...prev,
          [key]: { kind: "loaded", chats: chats.map((c) => ({ id: c.id, name: c.name ?? c.id })) },
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load chats";
        setChatLoads((prev) => ({ ...prev, [key]: { kind: "error", message } }));
      }
    }

    function pickChat(bt: BlitzTask, chat: ChatRow) {
      onSelect({
        projectId: bt.projectId,
        projectName: bt.projectName,
        taskId: bt.task.id,
        taskName: bt.task.name,
        chatId: chat.id,
        chatName: chat.name,
      });
    }

    return (
      <div
        ref={containerRef}
        role="dialog"
        aria-label="Pick a chat"
        className="absolute z-50 mt-1 w-80 max-h-96 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md shadow-xl overflow-hidden flex flex-col"
      >
        <div className="p-2 border-b border-[var(--color-border)]">
          <input
            ref={inputRef}
            type="text"
            placeholder="Search tasks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full px-2 py-1 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {grouped.length === 0 ? (
            <div className="p-4 text-sm text-[var(--color-text-muted)] text-center">No tasks</div>
          ) : (
            grouped.map((g) => (
              <div key={g.projectId}>
                <div className="px-3 py-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)]">
                  {g.projectName}
                </div>
                {g.tasks.map((bt) => {
                  const key = taskKey(bt);
                  const expanded = expandedTaskKey === key;
                  const load = chatLoads[key];
                  return (
                    <div key={key}>
                      <button
                        type="button"
                        onClick={() => void toggleExpand(bt)}
                        aria-expanded={expanded}
                        className="w-full text-left px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] flex items-center justify-between"
                      >
                        <span className="truncate">{bt.task.name}</span>
                        <span className="text-[var(--color-text-muted)] text-xs ml-2">{expanded ? "▾" : "▸"}</span>
                      </button>
                      {expanded && (
                        <div className="pl-6 pr-3 pb-2 bg-[var(--color-bg)]">
                          {!load || load.kind === "loading" ? (
                            <div className="py-1 text-xs text-[var(--color-text-muted)]">Loading chats…</div>
                          ) : load.kind === "error" ? (
                            <div className="py-1 text-xs text-[var(--color-error)] flex items-center justify-between">
                              <span>{load.message}</span>
                              <button
                                type="button"
                                onClick={() => void toggleExpand(bt)}
                                className="ml-2 underline text-[var(--color-text-muted)]"
                              >
                                Retry
                              </button>
                            </div>
                          ) : load.chats.length === 0 ? (
                            <div className="py-1 text-xs text-[var(--color-text-muted)]">No chats in this task</div>
                          ) : (
                            load.chats.map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => pickChat(bt, c)}
                                className="w-full text-left py-1 text-xs text-[var(--color-text)] hover:underline truncate"
                              >
                                {c.name}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 4.3: Adjust ChatRow if `ChatSessionResponse` uses a different field**

  If Step 4.1 showed `ChatSessionResponse` has `title` instead of `name` (or both), update the `chats.map((c) => ({ id: c.id, name: c.name ?? c.id }))` line accordingly. The intent: extract a stable id and a display label.

- [ ] **Step 4.4: Build and lint**

  Run: `cd grove-web && pnpm run build 2>&1 | tail -3 && pnpm eslint src/components/Blitz/ChatPickerDropdown.tsx --max-warnings 0 2>&1 | tail -3`

  Expected: clean. If type errors mention `c.name`, see Step 4.3.

- [ ] **Step 4.5: Commit**

  ```
  git add grove-web/src/components/Blitz/ChatPickerDropdown.tsx
  git commit -m "$(cat <<'EOF'
  feat(blitz): add ChatPickerDropdown for slot assignment

  Searchable two-level picker. Top: search input filtering by task
  name. Body: tasks grouped by project, click-to-expand reveals chats
  (lazy-fetched via listChats per task). Click chat → fires onSelect
  with a SlotAssignment. Closes on outside-click or Escape.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 5: EmptyGridSlot

**Files:**
- Create: `grove-web/src/components/Blitz/EmptyGridSlot.tsx`

**Rationale:** The "+ pick a chat" placeholder rendered for unassigned slots. Owns the picker open/close state for its slot.

- [ ] **Step 5.1: Create the file**

  Write `grove-web/src/components/Blitz/EmptyGridSlot.tsx`:

  ```tsx
  import { useState } from "react";
  import type { BlitzTask } from "../../data/types";
  import { ChatPickerDropdown } from "./ChatPickerDropdown";
  import type { SlotAssignment } from "./useBlitzGrid";

  interface EmptyGridSlotProps {
    blitzTasks: BlitzTask[];
    onSelect: (assignment: SlotAssignment) => void;
  }

  export function EmptyGridSlot({ blitzTasks, onSelect }: EmptyGridSlotProps) {
    const [pickerOpen, setPickerOpen] = useState(false);

    function handleSelect(assignment: SlotAssignment) {
      setPickerOpen(false);
      onSelect(assignment);
    }

    return (
      <div className="relative w-full h-full flex items-center justify-center border-2 border-dashed border-[var(--color-border)] rounded-md bg-[var(--color-bg)]">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          className="px-3 py-1.5 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] rounded-md transition-colors"
        >
          + pick a chat
        </button>
        {pickerOpen && (
          <ChatPickerDropdown
            blitzTasks={blitzTasks}
            onSelect={handleSelect}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    );
  }
  ```

- [ ] **Step 5.2: Build and lint**

  Run: `cd grove-web && pnpm run build 2>&1 | tail -3 && pnpm eslint src/components/Blitz/EmptyGridSlot.tsx --max-warnings 0 2>&1 | tail -3`

  Expected: clean.

- [ ] **Step 5.3: Commit**

  ```
  git add grove-web/src/components/Blitz/EmptyGridSlot.tsx
  git commit -m "$(cat <<'EOF'
  feat(blitz): add EmptyGridSlot placeholder

  Renders the "+ pick a chat" affordance for unassigned slots. Owns
  the picker open/close state. On select, closes the picker and
  forwards the SlotAssignment to the parent (which writes it through
  useBlitzGrid.assign).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 6: GridSlot

**Files:**
- Create: `grove-web/src/components/Blitz/GridSlot.tsx`

**Rationale:** Routes between empty placeholder and a populated slot (title bar + pinned TaskChat). Owns the stale-chat overlay logic when the chat's WebSocket disconnects with a non-clean code.

- [ ] **Step 6.1: Inspect the BlitzTask → Task shape so we can construct a Task for TaskChat**

  Run: `grep -A8 "export interface Task " grove-web/src/data/types.ts | head -15`

  TaskChat expects `task: Task`. GridSlot receives a SlotAssignment (which has `taskId`, `taskName`, etc., but not the full Task object). Solution: look up the full Task from the `blitzTasks` array passed down. If not found (the task was deleted), render stale state.

- [ ] **Step 6.2: Create the file**

  Write `grove-web/src/components/Blitz/GridSlot.tsx`:

  ```tsx
  import { useMemo, useState } from "react";
  import { X } from "lucide-react";
  import { TaskChat } from "../Tasks/TaskView/TaskChat";
  import type { BlitzTask } from "../../data/types";
  import { EmptyGridSlot } from "./EmptyGridSlot";
  import type { SlotAssignment } from "./useBlitzGrid";

  interface GridSlotProps {
    slotIdx: number;
    assignment: SlotAssignment | null;
    blitzTasks: BlitzTask[];
    onAssign: (slotIdx: number, assignment: SlotAssignment) => void;
    onClear: (slotIdx: number) => void;
  }

  export function GridSlot({ slotIdx, assignment, blitzTasks, onAssign, onClear }: GridSlotProps) {
    const [stale, setStale] = useState(false);

    const liveTask = useMemo(() => {
      if (!assignment) return null;
      return blitzTasks.find(
        (bt) => bt.projectId === assignment.projectId && bt.task.id === assignment.taskId,
      );
    }, [assignment, blitzTasks]);

    if (!assignment) {
      return (
        <EmptyGridSlot blitzTasks={blitzTasks} onSelect={(a) => onAssign(slotIdx, a)} />
      );
    }

    const titleBar = (
      <div className="flex items-center justify-between px-3 py-1.5 text-xs border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <span className="truncate text-[var(--color-text)]">
          <span className="text-[var(--color-text-muted)]">{assignment.projectName}</span>
          <span className="mx-1 text-[var(--color-text-muted)]">·</span>
          <span>{assignment.taskName}</span>
          <span className="mx-1 text-[var(--color-text-muted)]">·</span>
          <span className="text-[var(--color-accent)]">{assignment.chatName}</span>
        </span>
        <button
          type="button"
          aria-label={`Clear slot ${slotIdx + 1}`}
          onClick={() => onClear(slotIdx)}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );

    if (!liveTask) {
      return (
        <div className="flex flex-col h-full border border-[var(--color-border)] rounded-md overflow-hidden opacity-60">
          {titleBar}
          <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)] bg-[var(--color-bg)]">
            Chat unavailable
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col h-full border border-[var(--color-border)] rounded-md overflow-hidden">
        {titleBar}
        <div className="flex-1 overflow-hidden">
          {stale ? (
            <div className="h-full flex items-center justify-center text-sm text-[var(--color-text-muted)]">
              Connection lost — click the slot's clear button and reassign to retry.
            </div>
          ) : (
            <TaskChat
              projectId={liveTask.projectId}
              task={liveTask.task}
              pinnedChatId={assignment.chatId}
              hideHeader={true}
              onDisconnected={() => setStale(true)}
              onConnected={() => setStale(false)}
            />
          )}
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 6.3: Build and lint**

  Run: `cd grove-web && pnpm run build 2>&1 | tail -3 && pnpm eslint src/components/Blitz/GridSlot.tsx --max-warnings 0 2>&1 | tail -3`

  Expected: clean. If `lucide-react`'s `X` import fails, find the existing close-icon import in `FolderTreePickerDialog.tsx` (which we know uses `X`) and match that.

- [ ] **Step 6.4: Commit**

  ```
  git add grove-web/src/components/Blitz/GridSlot.tsx
  git commit -m "$(cat <<'EOF'
  feat(blitz): add GridSlot — title bar + pinned TaskChat or empty placeholder

  Routes to EmptyGridSlot when assignment is null. When assigned,
  renders the title bar (project · task · agent + clear button) and
  mounts a TaskChat instance pinned to the assignment's chatId.

  Looks up the live task from blitzTasks; if the task was deleted
  since assignment, renders a greyed-out "Chat unavailable" state.
  On WebSocket disconnect, swaps the chat surface for a stale notice.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 7: BlitzGridWorkspace

**Files:**
- Create: `grove-web/src/components/Blitz/BlitzGridWorkspace.tsx`

**Rationale:** Top-level composition of layout toolbar + CSS Grid of slots. Owns the shrink-confirm modal that intercepts layout changes that would drop assigned slots.

- [ ] **Step 7.1: Create the file**

  Write `grove-web/src/components/Blitz/BlitzGridWorkspace.tsx`:

  ```tsx
  import { useState } from "react";
  import type { BlitzTask } from "../../data/types";
  import { GridLayoutToolbar } from "./GridLayoutToolbar";
  import { GridSlot } from "./GridSlot";
  import { slotCountFor, useBlitzGrid } from "./useBlitzGrid";
  import type { GridLayout } from "./useBlitzGrid";

  interface BlitzGridWorkspaceProps {
    blitzTasks: BlitzTask[];
  }

  function gridTemplate(layout: GridLayout): { columns: string; rows: string } {
    switch (layout) {
      case "1":   return { columns: "1fr",        rows: "1fr" };
      case "2":   return { columns: "1fr 1fr",    rows: "1fr" };
      case "2x2": return { columns: "1fr 1fr",    rows: "1fr 1fr" };
      case "3x2": return { columns: "1fr 1fr 1fr", rows: "1fr 1fr" };
    }
  }

  export function BlitzGridWorkspace({ blitzTasks }: BlitzGridWorkspaceProps) {
    const { layout, assignments, setLayout, assign, clearSlot } = useBlitzGrid();
    const [pendingLayout, setPendingLayout] = useState<GridLayout | null>(null);

    function requestLayoutChange(next: GridLayout) {
      if (next === layout) return;
      const nextCount = slotCountFor(next);
      const wouldDrop = assignments.slice(nextCount).some((a) => a !== null);
      if (wouldDrop) {
        setPendingLayout(next);
      } else {
        setLayout(next);
      }
    }

    function confirmShrink() {
      if (pendingLayout) setLayout(pendingLayout);
      setPendingLayout(null);
    }

    const tpl = gridTemplate(layout);

    return (
      <div className="flex flex-col h-full bg-[var(--color-bg)]">
        <GridLayoutToolbar current={layout} onChange={requestLayoutChange} />
        <div
          className="flex-1 grid gap-2 p-2 min-h-0"
          style={{ gridTemplateColumns: tpl.columns, gridTemplateRows: tpl.rows }}
        >
          {assignments.map((assignment, i) => (
            <GridSlot
              key={i}
              slotIdx={i}
              assignment={assignment}
              blitzTasks={blitzTasks}
              onAssign={assign}
              onClear={clearSlot}
            />
          ))}
        </div>
        {pendingLayout && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-md p-4 max-w-sm">
              <p className="text-sm text-[var(--color-text)] mb-4">
                Shrinking the grid will clear {slotCountFor(layout) - slotCountFor(pendingLayout)} assigned slot(s). Continue?
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingLayout(null)}
                  className="px-3 py-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmShrink}
                  className="px-3 py-1 text-sm bg-[var(--color-accent)] text-[var(--color-bg)] rounded font-semibold"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 7.2: Build and lint**

  Run: `cd grove-web && pnpm run build 2>&1 | tail -3 && pnpm eslint src/components/Blitz/BlitzGridWorkspace.tsx --max-warnings 0 2>&1 | tail -3`

  Expected: clean.

- [ ] **Step 7.3: Commit**

  ```
  git add grove-web/src/components/Blitz/BlitzGridWorkspace.tsx
  git commit -m "$(cat <<'EOF'
  feat(blitz): add BlitzGridWorkspace top-level grid view

  Composes GridLayoutToolbar over a CSS Grid of GridSlot instances.
  Subscribes to useBlitzGrid for state. Intercepts layout changes
  that would drop assigned slots with a confirm modal.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 8: BlitzPage integration

**Files:**
- Modify: `grove-web/src/components/Blitz/BlitzPage.tsx`

**Rationale:** Wire `gridMode` state into the existing BlitzPage, plus the Cmd+G shortcut and a "Grid view" toolbar button. When `gridMode === true`, render `BlitzGridWorkspace` instead of the task-list-or-workspace pair.

- [ ] **Step 8.1: Read BlitzPage entry**

  Run: `sed -n '1,80p' grove-web/src/components/Blitz/BlitzPage.tsx`

  Identify:
  - The imports block
  - The component's main return statement (likely far down — search for the top-level JSX block)
  - The existing keyboard-handling effect (likely uses `useEffect` with `document.addEventListener("keydown", ...)`)
  - The Blitz top toolbar / header area where the "Grid view" button should sit

- [ ] **Step 8.2: Add the import**

  At the top of `grove-web/src/components/Blitz/BlitzPage.tsx`, after the existing imports from `./` files, add:
  ```ts
  import { BlitzGridWorkspace } from "./BlitzGridWorkspace";
  ```

- [ ] **Step 8.3: Add `gridMode` state**

  Inside `BlitzPage()`, near the other `useState` calls at the top of the component body, add:
  ```ts
  const [gridMode, setGridMode] = useState(false);
  ```

- [ ] **Step 8.4: Add the Cmd+G keyboard shortcut**

  Find the existing keyboard-handling `useEffect` (look for a `useEffect` with `document.addEventListener("keydown"` or a `useGlobalKeyboardShortcut` hook call). Two cases:

  **Case A — existing keydown effect exists**: add a branch to it for `e.key === "g" && (e.metaKey || e.ctrlKey)` that calls `setGridMode((v) => !v)` and `e.preventDefault()`. Skip when an input/textarea is focused (mirror the existing pattern in that effect).

  **Case B — no existing keydown effect or it's locked to specific handlers**: add a new effect:
  ```ts
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
          return;
        }
        e.preventDefault();
        setGridMode((v) => !v);
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  ```

  **If uncertain which case applies**: report DONE_WITH_CONCERNS with the existing keyboard-handling code pasted; the controller will clarify.

- [ ] **Step 8.5: Add the "Grid view" toolbar button**

  Find the Blitz top toolbar / header area (likely near the task-list rendering, has buttons for things like "Switch to Zen"). Add a button:
  ```tsx
  <button
    type="button"
    onClick={() => setGridMode((v) => !v)}
    aria-pressed={gridMode}
    className="px-2.5 py-1 text-xs rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
    title="Toggle grid workspace (⌘G)"
  >
    Grid view
  </button>
  ```

  Placement: near the existing "Switch to Zen" button or similar — match the surrounding button styling exactly. If the existing button uses different className tokens, use those instead. The intent is visual consistency, not pixel-perfect adoption of the snippet above.

- [ ] **Step 8.6: Conditional render**

  Find the JSX that currently renders the task list or the single-task workspace (near the bottom of the component return). Wrap with a conditional:
  ```tsx
  {gridMode ? (
    <BlitzGridWorkspace blitzTasks={blitzTasks} />
  ) : (
    /* existing JSX unchanged */
  )}
  ```

  The "existing JSX unchanged" comment is a marker — actually leave the existing JSX in place inside the `else` branch.

- [ ] **Step 8.7: Build and lint**

  Run: `cd grove-web && pnpm run build 2>&1 | tail -3 && pnpm eslint src/components/Blitz/BlitzPage.tsx --max-warnings 0 2>&1 | tail -3`

  Expected: clean.

- [ ] **Step 8.8: Commit**

  ```
  git add grove-web/src/components/Blitz/BlitzPage.tsx
  git commit -m "$(cat <<'EOF'
  feat(blitz): wire grid workspace into BlitzPage

  Adds gridMode state, Cmd+G keyboard toggle, "Grid view" toolbar
  button. When enabled, BlitzGridWorkspace replaces the task-list /
  single-task-workspace render. Toggle state is component-local —
  grid contents (layout + assignments) persist via useBlitzGrid.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

---

## Task 9: Manual end-to-end verification

**Files:** none modified.

**Rationale:** Last-mile verification per the spec's testing section. Catches anything subagent-driven implementation may have missed.

- [ ] **Step 9.1: Full build**

  Run from repo root:
  ```
  cd grove-web && pnpm run build && cd .. && cargo build
  ```

  Expected: both succeed.

- [ ] **Step 9.2: Launch grove web on a free port**

  Run: `ss -ltn | grep -E ':30(50|51|52|53) ' || echo "ports 3050-3053 free"`. Pick a free one (likely 3050).

  Run (background): `./target/debug/grove web --port 3050 --no-open`

  Wait for ready: poll `curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3050/"` until 200.

- [ ] **Step 9.3: Open browser and walk the 10 verification scenarios**

  Open `http://localhost:3050` (or via the LAN URL if testing remotely). Walk each scenario from the spec's Testing section:
  1. Toggle on/off (Cmd+G, Escape, button)
  2. All four layouts (1, 2, 2×2, 3×2). Shrink past assigned slots → confirm modal appears.
  3. Slot lifecycle — assign → TaskChat mounts → WebSocket in DevTools Network. Clear → unmount → close.
  4. Multi-slot concurrent — fill 6 slots from different projects, no crosstalk in agent replies.
  5. Persistence — reload page → slots restore.
  6. Stale assignment — delete the underlying chat → grid shows "Chat unavailable" greyed state.
  7. WebSocket cap — fill 6 + open Zen mode in another tab → cap message in 7th slot.
  8. Mobile (browser devtools narrow viewport) — picker takes full-screen height on narrow viewports, 1 / 2 layouts usable.
  9. Persistence isolation — different browser → fresh grid.
  10. 30-minute leak smoke — all 6 slots filled + active agent traffic. Heap snapshot before/after. Record delta.

  Any failure: STOP and report. Do NOT mark this task complete unless all 10 pass (or scenario 10 returns to baseline within reason — flag concerning growth as DONE_WITH_CONCERNS).

- [ ] **Step 9.4: Kill the server**

  Run: `pkill -f "target/debug/grove web --port 3050"; sleep 2`

- [ ] **Step 9.5: No commit — manual verification only**

  Update the task tracker to completed. The 8 feature commits from Tasks 1-8 are the deliverable.

---

## Out of scope / follow-ups

Acknowledged-but-deferred items per the spec:

- **Pop-out windows (Phase 2)** — separate spec when desired
- **Vitest setup + `useBlitzGrid` unit tests** — frontend has no test framework today; adding one mid-feature is scope creep. Worth a separate "establish frontend test infra" effort.
- **Drag-and-drop slot assignment** — picker-only in v1
- **Keyboard-driven assignment** (j/k + Cmd+1-6 to send a chat to a slot) — Cmd+1-6 is reserved for *focusing* a slot, not assigning, in v1
- **Resize handles / splitter bars** — fixed CSS Grid only
- **Mobile auto-collapse rules** — user picks 1 or 2 preset on phone; auto-shrink rule deferred
- **Accessibility audit (full keyboard nav, ARIA roles on picker)** — basic ARIA in place; full audit is a separate effort
- **Per-slot focus shortcut (Cmd+1-6 → focus slot's reply input)** — spec includes this but it's NOT in the plan above. If you want it before merge, add a Task 8.5 that wires keyboard handlers in `BlitzGridWorkspace` to call `slot.focus()` via refs.

## Codex review integration

Per the user directive, **add a Codex review pass after the existing 2-stage Claude review on each task.** The execution flow per task is:

1. Implementer subagent does the task (per `superpowers:subagent-driven-development`)
2. Claude spec compliance reviewer checks the diff against the task description
3. Claude code quality reviewer checks the diff for craft + adherence to plan
4. **Codex independent review** — dispatch the `codex:rescue` agent with:
   - The git diff for the task (BASE_SHA → HEAD_SHA)
   - The task description (above)
   - The spec section the task addresses
   - Ask Codex to flag: correctness, type-safety, React hook hygiene, accessibility, performance concerns
5. Surface any Codex findings to the implementer subagent for a fix pass
6. Re-run quality review + Codex review until both approve
7. Mark task complete

This adds ~1 extra subagent call per task. Total per-task overhead: 3 reviewers × ~30K tokens each = ~90K tokens for review. For 8 implementation tasks: ~720K tokens of review overhead. Acceptable given the user directive.
