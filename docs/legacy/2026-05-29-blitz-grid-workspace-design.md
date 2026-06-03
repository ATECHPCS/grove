# Blitz Grid Workspace — Design

**Date:** 2026-05-29
**Branch:** `blitz/grid-workspace` (off `master`)
**Scope:** New optional view in Blitz mode that lets the user watch 4-6 different coding sessions side-by-side in an in-page grid. Each grid slot hosts one chat (`TaskChat` instance).

## Goal

In Blitz mode today, the user can either browse a task list or enter a single task's workspace. Add a third peer view — the **grid workspace** — that displays 1, 2, 4, or 6 chats simultaneously in a CSS Grid layout. The grid is opt-in (button or Cmd+G), additive (does not disrupt the existing task-list or single-task workspace), and persists slot assignments + layout choice across reloads via localStorage.

## Non-goals (deferred)

- **Pop-out windows.** Detaching a slot into its own browser window — explicitly Phase 2, separate spec.
- **Backend persistence.** Grid config is browser-side only. No SQL schema changes, no new HTTP routes.
- **Drag-and-drop assignment.** v1 uses click-slot → picker. Drag-and-drop is a follow-up enhancement.
- **Keyboard-driven assignment** (j/k + Cmd+1-6 to send a chat to a slot). Cmd+1-6 is reserved for *focusing* a slot, not assigning.
- **Resize handles / splitter bars.** Fixed CSS Grid layouts per preset only.
- **Mobile auto-collapse rules.** Larger grid layouts (2×2, 3×2) are cramped on phones; phone users are expected to pick the 1 or 2 preset. A future "auto-collapse on narrow viewport" rule may be added if needed.

## Context

### Today's Blitz mode

- `BlitzPage.tsx` renders either the **task list** (across all projects, j/k-navigable) or the **single-task workspace** (mounted via `TaskView` when the user clicks a task)
- One `TaskChat` instance is alive at a time, hosting one chat
- Cmd+1-9 inside the workspace switches FlexLayout panel tabs

### Multi-instance safety of `TaskChat`

`TaskChat.tsx` is ~7000 LOC but each instance is closure-state-isolated:
- Per-chat `wsMapRef` is instance-local (no global singletons)
- API calls are keyed by `(projectId, taskId, chatId)` triple — no collision risk across instances
- No `window`-level event handlers with hardcoded keys
- ResizeObservers and DOM measurements are per-instance

**Constraint:** Browsers cap concurrent WebSockets at ~6 per origin. A 3×2 grid with one chat per slot = 6 active WebSockets. If a user has another Grove tab open (Zen mode), the 7th connection will fail. Spec handles this gracefully (see Error handling).

### Per-project vs global scope

Blitz is the cross-project view by design. Grid config (layout + assignments) is therefore **global to Blitz**, not per-project — one localStorage key holds the whole config. Slot assignments can reference chats from any project the user has access to.

## Approach

**Blitz mode gains a third peer view.**

| View | Trigger | State |
|---|---|---|
| Task list | (default) | shared across Blitz views |
| Single-task workspace | click a task in the list | per-task instance of `TaskView` |
| Grid workspace | **Cmd+G** or **"Grid view" button** in the Blitz toolbar | persisted to `localStorage["grove:blitz-grid"]` |

The grid is purely additive — zero changes to the existing task-list or single-task code paths.

### Grid composition

- **Layout toolbar** at the top of the grid view: 4 preset buttons (`1`, `2`, `2×2`, `3×2`)
- **N slots below** rendered via CSS Grid — `grid-template-columns` and `grid-template-rows` chosen by the active preset
- **Each slot** has:
  - A title bar: `{project} · {task} · {agent}` plus a `✕` button to clear the slot
  - A single `TaskChat` instance scoped to `(projectId, taskId, chatId)`
- **Empty slot** (assignment `null`) renders an `EmptyGridSlot` placeholder ("+ pick a chat")

### Slot assignment flow

1. User clicks an empty slot
2. `ChatPickerDropdown` opens anchored to the slot
3. Picker body shows all `blitzTasks` (already loaded by `BlitzPage`), grouped under project headers
4. User clicks a task → picker calls `listChats(projectId, taskId)` and expands inline
5. User clicks a chat → picker fires `onSelect({projectId, taskId, chatId})`
6. `useBlitzGrid.assign(slotIdx, target)` updates state and persists to localStorage
7. The slot re-renders → `TaskChat` mounts → its WebSocket opens

### Keyboard shortcuts

| Key | Behavior |
|---|---|
| `Cmd+G` | Toggle grid view on/off (when in Blitz mode) |
| `Cmd+1-6` | Focus a slot's reply input (only active inside the grid view) |
| `Escape` | Exit grid view back to the task list |
| (existing) `Cmd+1-9` for tab switching | Unchanged — only applies in single-task workspace, not the grid |

## Components

All new files live under `grove-web/src/components/Blitz/`.

| File | New/Modify | Responsibility | Est. LOC |
|---|---|---|---|
| `BlitzPage.tsx` | modify | Add `gridMode` boolean state. Cmd+G toggle. "Grid view" toolbar button. When `gridMode === true`, render `BlitzGridWorkspace` instead of the task-list-or-single-task pair. | +30 |
| `BlitzGridWorkspace.tsx` | new | Top-level grid view. Composes the layout toolbar + grid of slots. Reads state from `useBlitzGrid`. | ~80 |
| `GridLayoutToolbar.tsx` | new | Row of preset buttons (`1`, `2`, `2×2`, `3×2`). Pure presentational. Props: `current`, `onChange`. | ~40 |
| `GridSlot.tsx` | new | Single slot. If `assignment === null` → renders `EmptyGridSlot`. Otherwise renders title bar + one `TaskChat` instance. Owns the `onDisconnected` → "stale" overlay logic. | ~100 |
| `EmptyGridSlot.tsx` | new | The "+ pick a chat" placeholder. Click → opens `ChatPickerDropdown` anchored to itself. | ~30 |
| `ChatPickerDropdown.tsx` | new | Searchable picker. Search input filters by task name. Body: tasks grouped by project, click-to-expand reveals chats (lazy via `listChats`). Click chat → `onSelect`. | ~150 |
| `useBlitzGrid.ts` | new | Custom hook owning grid state. Returns `{ layout, setLayout, assignments, assign, clearSlot }`. Hydrates from / persists to `localStorage["grove:blitz-grid"]` (throttled 200ms). Validates layout preset against whitelist. | ~80 |

**Reused (not modified):**
- `TaskChat.tsx` — as-is in each slot
- `apiClient.listChats(projectId, taskId)` — existing endpoint
- `blitzTasks` from existing Blitz hooks — passed down to the picker

**No backend changes.** All persistence is browser-side localStorage. No new HTTP routes, no schema migrations.

**Grid CSS:** standard CSS Grid via `grid-template-columns`/`grid-template-rows` keyed off the preset. No splitters, no resize handles.

## Data flow

### Opening grid view

```
User: Cmd+G or "Grid view" button click
  → BlitzPage.setGridMode(true)
  → BlitzGridWorkspace mounts
  → useBlitzGrid hydrates from localStorage["grove:blitz-grid"]
       → { layout: "2x2", assignments: [a, b, null, null] }
  → GridLayoutToolbar renders (current="2x2")
  → Grid renders 4 GridSlots
       Slot 0 (assigned) → mount TaskChat → opens WebSocket
       Slot 1 (assigned) → mount TaskChat → opens WebSocket
       Slot 2 (empty)   → render EmptyGridSlot
       Slot 3 (empty)   → render EmptyGridSlot
```

### Assigning a chat to an empty slot

```
User clicks "+ pick a chat" on Slot 2
  → EmptyGridSlot.setPickerOpen(true)
  → ChatPickerDropdown opens (uses blitzTasks already in state, no fetch)
  → Renders tasks grouped by project header
  → User clicks a task row
       → picker calls listChats(projectId, taskId)
       → inline expansion shows chats
  → User clicks a chat
       → picker fires onSelect({projectId, taskId, chatId})
  → useBlitzGrid.assign(2, target)
       → updates assignments[2]
       → persists to localStorage (throttled 200ms)
  → GridSlot 2 re-renders
       → mounts TaskChat → opens new WebSocket
```

### Changing layout 2×2 → 3×2

```
User clicks "3×2" preset
  → GridLayoutToolbar.onChange("3x2")
  → useBlitzGrid.setLayout("3x2")
       → expands assignments from 4 → 6 with null padding
       → persists
  → CSS Grid template updates: grid-template-columns: 1fr 1fr 1fr; rows: 1fr 1fr
  → Two new empty slots appear
  → Existing slots stay mounted (TaskChat instances unchanged → no WebSocket churn)
```

### Clearing a slot

```
User clicks ✕ on a slot's title bar
  → useBlitzGrid.clearSlot(slotIdx)
       → assignments[slotIdx] = null
       → persists
  → Slot re-renders as EmptyGridSlot
  → Previous TaskChat unmounts → WebSocket closes (existing TaskChat cleanup)
```

### Leaving grid view

```
User: Escape, click a sidebar task, or click "Grid view" toggle again
  → BlitzPage.setGridMode(false)
  → BlitzGridWorkspace unmounts
       → all TaskChat instances unmount → all WebSockets close
  → localStorage["grove:blitz-grid"] retains the config
  → Next time user opens grid view, slots re-populate from persisted state
```

### Layout shrink past assigned slots (edge case)

```
User has 3×2 layout with chats in slots 4-5; clicks "2×2"
  → GridLayoutToolbar shows confirm modal
       "Slots 5-6 will be cleared. Continue?"
  → If user confirms:
       → assignments truncate from 6 → 4 (slots 4-5 discarded)
       → those TaskChats unmount → WebSockets close
       → persists
  → If user cancels:
       → no state change
```

The confirm modal only opens when shrinking would drop **non-null** assignments. Shrinking with empty slots in the to-be-dropped range happens silently.

## Error handling

Pattern: **a broken slot never blocks other slots from working.** Every failure path degrades to "empty slot" or "stale slot" + console warn.

| Failure | Behavior | Mitigation |
|---|---|---|
| **localStorage unavailable** (private browsing, disabled) | `useBlitzGrid` catches the throw; falls back to in-memory state. Grid works during the session but does not persist. | Wrap reads/writes in try/catch. Log warn once. No user-facing toast. |
| **localStorage payload corrupt or schema-mismatched** | Parse failure → discard payload, start fresh with empty assignments + default layout (`2x2`). | Wrap `JSON.parse` in try/catch. Tag payload with `{ version: 1, ... }` for future schema migrations. |
| **Assigned chat no longer exists** | TaskChat's WebSocket close fires with non-1000 code. Slot enters "stale" state: title bar shows cached `project · task · agent` greyed-out + "Chat unavailable" line. `✕` clears it. | GridSlot subscribes to TaskChat's `onDisconnected` callback. Renders stale overlay instead of remounting. |
| **Assigned task or project deleted** | Same as above. No proactive validation on grid mount — too expensive (would require pinging every assigned chat). | Same handling. |
| **`listChats` fails inside the picker** (network, 401) | Picker shows inline error "Couldn't load chats" + retry button. Other tasks still expand normally. | Existing `apiClient` error handling pattern (matches `AddProjectDialog` and `FolderTreePickerDialog`). |
| **Layout preset value unknown** (localStorage has `"5x2"` from a future schema) | `useBlitzGrid` validates against allowed set `["1", "2", "2x2", "3x2"]` on hydrate. Unknown → fall back to default `"2x2"`. | Whitelist check in the hook. |
| **WebSocket cap exceeded** | Browser refuses 7th WebSocket; TaskChat's `onerror` fires. Slot renders inline "Connection limit reached — close another Grove tab and click the slot to retry". | Detect via TaskChat `onerror` + `event.code === 1006` close. Phase 2's pop-out becomes the natural escape valve later; v1 just shows the message. |
| **Cmd+G conflict** (browser extension intercepts) | Toolbar button is the canonical UI; shortcut is an enhancement. | Document; the button always works. |
| **User shrinks layout past assigned slots** | Confirm modal blocks accidental data loss. | See data flow section. |
| **Picker opened on a phone** | Two-level expand-inline UI works on touch (no hover-only states). Dropdown takes full-screen height on narrow viewports. | CSS responsive query, matching existing Grove dialogs. |

**Not defended against (intentional):**
- Concurrent grid edits from two browser tabs — last write wins. `storage` event sync is out of scope for v1.

## ⚠️ Known risk: TaskChat instance proliferation may expose latent leaks

`TaskChat.tsx` is ~7000 LOC and runs many subscriptions per instance (WebSocket map, ResizeObservers, Virtuoso, an active-chat effect chain). v1 will mount **up to 6 instances simultaneously** — significantly more than the codebase has ever exercised. Any per-instance leak that was harmless at 1× becomes 6× as severe.

**Mitigation:**
- Before merging upstream, run a smoke session with all 6 slots filled and active agent traffic for ~30 minutes. Take heap snapshots before/after via Chrome DevTools. Document the delta.
- If a leak is found, fix it in `TaskChat` (separate PR / commit, not part of the grid feature) before shipping the grid to production.

## Testing

### Unit tests

`useBlitzGrid.test.ts` — pure hook logic via `renderHook` + a `localStorage` mock:
- Hydrates from localStorage on mount
- `assign(slotIdx, target)` writes to `assignments` + persists
- `clearSlot` writes null + persists
- `setLayout` truncates / pads `assignments` correctly
- Hydration falls back to defaults when localStorage is corrupt
- Unknown layout preset falls back to `"2x2"`
- Quota-exceeded write doesn't throw

**Open question (flag for plan phase):** does Grove already have a Vitest setup? If not, the plan must include adding it (one small commit) before the unit-test commit. Skim of `grove-web/package.json` should answer this — call it out in the implementation plan.

### Manual verification

1. **Toggle** — Cmd+G enters grid view, Escape exits, "Grid view" button toggles. State persists across toggle.
2. **All four layouts** — 1, 2, 2×2, 3×2. Confirm CSS Grid renders correctly. Shrinking past assigned slots shows the confirm modal.
3. **Slot lifecycle** — pick a chat → TaskChat mounts → WebSocket opens (visible in DevTools Network → WS). Clear slot → TaskChat unmounts → WebSocket closes.
4. **Multi-slot concurrent** — fill all 6 slots in 3×2, all from different projects. Type a reply in each, verify each one sends to the correct chat (no crosstalk). Watch DevTools heap for ~5 min.
5. **Persistence** — set up 2×2 with 2 chats assigned, reload page, re-enter grid view, confirm slots restore.
6. **Stale assignment** — assign a chat, delete it via the task list (or another tab). Re-enter grid view, confirm "Chat unavailable" state, confirm `✕` clears it.
7. **WebSocket cap** — fill 6 slots, open another tab pointing at the same Grove instance in Zen mode. Confirm either both work (if Zen shares WSes somehow) or the 7th fails gracefully with the cap message.
8. **Mobile** — phone-width viewport. Picker takes full-screen height. 1 / 2 layouts usable.
9. **Persistence isolation** — different browser → fresh grid (localStorage is browser-scoped).
10. **30-minute leak smoke** — all 6 slots filled, active agent traffic for ~30 min. Heap snapshots before/after. Document delta.

### Out of scope

- Lighthouse / accessibility audits (worthwhile follow-up, not v1)
- E2E browser automation (Grove has no Playwright setup; adding one is a separate effort)

## Phasing

This spec is **Phase 1 only.** A future Phase 2 spec will cover:
- Per-slot pop-out via `window.open` + BroadcastChannel state sync
- HMAC token handoff to pop-out windows so they authenticate to the WebSocket on their own
- Pop-out window lifecycle (close → does the slot reappear in grid? does it stay popped across reload?)

The Phase 1 architecture should accommodate Phase 2 without restructuring:
- Slot state shape (`{projectId, taskId, chatId}`) is already serializable / hoistable to another window
- `useBlitzGrid` already owns the persistence layer; pop-out windows can share via `BroadcastChannel("grove-blitz-grid")` in Phase 2

## File changes summary

| File | Change |
|---|---|
| `grove-web/src/components/Blitz/BlitzPage.tsx` | +30 LOC (gridMode state, Cmd+G, toolbar button) |
| `grove-web/src/components/Blitz/BlitzGridWorkspace.tsx` | new, ~80 LOC |
| `grove-web/src/components/Blitz/GridLayoutToolbar.tsx` | new, ~40 LOC |
| `grove-web/src/components/Blitz/GridSlot.tsx` | new, ~100 LOC |
| `grove-web/src/components/Blitz/EmptyGridSlot.tsx` | new, ~30 LOC |
| `grove-web/src/components/Blitz/ChatPickerDropdown.tsx` | new, ~150 LOC |
| `grove-web/src/components/Blitz/useBlitzGrid.ts` | new, ~80 LOC |
| `grove-web/src/components/Blitz/__tests__/useBlitzGrid.test.ts` | new, ~150 LOC (assuming Vitest already configured; otherwise extra setup commit) |

**Total:** ~660 LOC across 8 files. No backend changes. No schema migrations. No new dependencies (unless Vitest needs adding, TBD during planning).
