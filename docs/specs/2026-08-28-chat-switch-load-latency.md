# Chat switch/boot load latency (Defect B)

_Status: A1 + B1 + A3 + B2 shipped (0.12.6–0.12.7); A2 (structural tail pagination) still deferred — 2026-08-28_
_Branch: `local/prod`_

## Progress

- **A1** ✅ `spawn_blocking` the history read+parse (`load_history_async`) — 0.12.6.
- **B1** ✅ 3-slot concurrency limiter on the grid `getChatHistory` fan-out — 0.12.6.
- **A3** ✅ bounded (8 MiB tail) reconcile read (`load_recent_history_async`) so the
  WS-connect permission reconcile no longer re-parses the whole file — 0.12.7.
- **B2** ✅ seed sibling running-indicators on mount from `GET /projects/{id}/active-chats`
  (in-memory ACP snapshot, no history parse) → `seedRunningFromSnapshot` — 0.12.7.
- **A2** ⏳ real tail pagination — still deferred; needs the Virtuoso prepend surface +
  server-side memory/attachment metadata (see below).

Distinct from the render-derivation work in `2026-08-28-chat-load-perf.md`. That
tranche cut **in-chat streaming** cost. This one targets **time-to-visible** when
a chat first loads: slow cold boot, and ~30 s to switch into blitz/grid.

## Root cause (confirmed by two independent traces)

One cause, three amplifiers: **there is no real tail pagination — the whole
`history.jsonl` is read + JSON-parsed per open, 2–3× on the backend,
synchronously, then fully replayed on the frontend.**

- `get_chat_history` returns **all** events from offset 0; the frontend always
  sends `offset=0` (`acp.rs:2595-2622`, `grove-web/src/api/tasks.ts`). `offset`
  is applied *after* the whole file is parsed — pagination is a mirage.
- `load_history` reads up to the last **50 MiB** (`MAX_HISTORY_READ_BYTES`) and
  `serde_json`-parses every line **on the tokio worker thread — no
  `spawn_blocking`** (`chat_history.rs:304-363`), so it blocks the async runtime.
- Per-event `prepare_update_for_storage` (a live legacy migration) runs on the
  **read** path every load (`chat_history.rs:345`).
- The same file is parsed again on the WS-connect permission reconcile
  (`acp.rs:1053-1055`) and again on resume-cancel (`chat_history.rs:371`) →
  up to **3× per open**.
- **Cold boot:** `TasksPage` auto-selects the first task; its `TaskChat` loads
  that whole history (2× backend + full frontend replay). Boot cost ∝ size of
  whichever task is selected first.
- **Blitz/grid switch:** toggling zen↔blitz or the grid **remounts** every pane;
  each grid tile is its own `TaskChat` that cold-fires a WS connect +
  `getChatHistory` on mount, and the remount wipes the per-instance warm-cache
  refs. With K tiles that is **K concurrent history GETs → up to 3×K full-file
  parses, no throttle** = the 30 s stall.
- **Empty session rail after a mode switch:** on mount only the active chat
  connects a WS, and `sessionActivity` is per-instance (`sessionActivity.ts` —
  "not persisted across remounts"), so sibling running-indicators are not seeded.

## Plan — safe wins first, pagination last (it needs a frontend prepend surface)

### Phase A — backend

- **A1. `spawn_blocking` the read+parse in `load_history`.** Smallest, safest,
  immediate: stops the parse from blocking tokio workers so concurrent pane
  loads and the rest of the UI overlap instead of serializing. Helps boot AND
  switch with near-zero correctness risk.
- **A3. Bound the reconcile read.** The WS-connect permission reconcile
  (`acp.rs:1053`) re-parses the whole file only to find unresolved permission
  ids — cap it to the recent tail (unresolved permissions are recent by nature),
  or share the HTTP read. (Resume-cancel *writes* synthetic events, so it can't
  share a pre-cancel read — leave it, or paginate its read independently.)
- **A2. Real tail pagination (the structural win, but entangled).** Add a
  `limit` (last-N events) to `get_chat_history`; initial load fetches a bounded
  window instead of the whole file. **Gotcha:** today the frontend computes
  `readMemoryIds` and attachment counters over the *full* history before pruning
  ("a visual optimization must not erase Memory usage", `TaskChat.tsx`). If the
  backend returns only last-N, those are lost — so A2 must **compute
  memory-ids + attachment counts server-side over the full file (cheap scalar
  scan) and return them as metadata** alongside the last-N event bodies.
  **Also:** returning only last-N makes older history unreachable in the UI —
  A2 therefore *requires* a way to fetch older on demand (Virtuoso
  `firstItemIndex`/`startReached` prepend, or an explicit "load full history"
  action). This is the fragile prepend surface deferred earlier; A2 should not
  ship without it.

### Phase B — frontend

- **B1. Cap/stagger the grid fan-out.** A small concurrency limiter around the K
  panes' `getChatHistory` so a mode switch doesn't fire a thundering herd. Cuts
  the peak even before A2.
- **B2. Seed sibling status on mount.** Fetch a lightweight "which chats are
  busy" snapshot (SQLite/session metadata, **not** history) on mount and seed
  `sessionActivity`, so the rail shows running siblings immediately after a
  remount. Pairs with the tranche-1-fix's `onChatBecameIdle` wiring.

### Phase C — measure

`PERF=1` before/after on a real long chat and a K-pane grid: backend tab P95 for
`/history`, timeline switch-to-first-paint, memory tab for worker-block relief.

## Recommended order

**A1 → B1 → B2 → A3 → A2.** A1 and B1/B2 are low-risk, high-value, and need no
prepend surface. A2 is the biggest single win but couples to the Virtuoso
prepend work; do it last, deliberately, with the server-side memory/attachment
metadata and a load-older affordance.
