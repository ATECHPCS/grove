# Chat conversation-load performance

_Status: in progress — 2026-08-28_
_Branch: `feat/chat-load-perf` (off `deploy/phase0`)_

## Problem

Opening / switching to a task chat is slow to become visible and interactive,
worse the longer the conversation. Investigation (frontend render path + backend
history fetch) found the load path does the expensive work **2–4× more than
necessary** at both layers.

### Backend (evidence)

Chat history is **not** in SQLite — it is a per-chat append-only JSONL file:
`~/.grove/projects/{project}/tasks/{task}/chats/{chat}/history.jsonl`
(`src/storage/chat_history.rs`). Opening a chat reads/parses/transforms that
whole file, and does so **up to 3× per open**:

1. `get_chat_history` HTTP handler — `load_history` → deep-clone → `map(ServerMessage::from)` → serde serialize (`src/api/handlers/acp.rs:2444`). 3–4 full passes + 3 allocations of the whole history.
2. WS attach permission-reconcile — a **second** full `load_history` (`acp.rs:1053`).
3. WS resume cancel — `cancel_unresolved_events` → a **third** full `load_history` (`chat_history.rs:371`).

Pagination is a mirage: `offset` is applied *after* the whole file is parsed
(`acp.rs:2453`) and the frontend always sends `offset=0`
(`grove-web/src/api/tasks.ts:1124`). `prepare_update_for_storage` also re-runs on
the **read** path (`chat_history.rs:345`) though it already ran on write.

### Frontend (evidence)

- **Redundant refetch:** `switchChat` paints instantly from an in-memory
  per-chat cache, then a second effect unconditionally re-`GET`s the full history
  and rebuilds + re-sets the message array on **every** switch
  (`TaskChat.tsx:4792,4813,4849`) → a second full re-render/re-mount/re-measure.
- **Eager hot-zone mount:** the last `TASK_CHAT_RECENT_TURN_HOT_ZONE = 50` turns
  are never virtualized; they mount synchronously into the Virtuoso footer in one
  commit (`TaskChat.tsx:8616,9176`).
- **Unmemoized markdown:** each mounted message re-runs react-markdown +
  `rehype-raw` + `rehype-sanitize`; the component is memoized but the **parse tree
  is not cached** (`MarkdownRenderer.tsx:1429`).
- Plus: per-row synchronous `getBoundingClientRect` reflow storm (`8657`), a
  12-frame invisible scroll-retry loop (`useChatPositioning.ts:79`), O(total)
  derivations every render / O(n²) while streaming (`8597,2106`), and render
  windowing **off by default** (`limit:0`, `1507`).

Confirm any of these with the built-in perf monitor (`PERF=1 make web` →
timeline / renders / network / backend tabs; instrument `acp.rs:2444`).

## Scope of this change (first tranche)

Three independent, low-risk changes that remove the worst redundancy without
touching the fragile scroll/virtualization machinery:

### Option 1 — Cache-guard the history refetch (frontend)

The load-history effect fires on every `activeChatId` change and refetches even
when the per-chat cache already holds a complete history. Guard it: when the
cache is warm (has messages and the WS is/was connected for that chat), skip the
HTTP refetch and rely on the live WS stream to keep it current; still fetch on
cold open, on a cache miss, or when the cache was never confirmed complete.

- Keeps the instant cached paint; removes the redundant second fetch + full
  reduce + re-`setMessages` on warm switches.
- Freshness: the WS attaches before the (now-skipped) fetch and streams forward;
  the cache is only trusted when it was populated from a prior completed load for
  that chat in this session.

### Option 2 — Memoize the markdown parse per message (frontend)

Completed history messages are immutable, yet their markdown is re-parsed
(+`rehype-raw`/`rehype-sanitize`) every mount. Add a bounded LRU cache keyed by a
cheap content hash so each distinct message body parses once. Streaming
(changing) messages bypass the cache and render live as today.

- Shrinks the hot-zone mount burst (the dominant on-open frontend cost).
- Isolated to `MarkdownRenderer`; no behavior change to rendered output.

### Option 3 — Collapse the 3× backend history reads per open (backend)

`load_history` runs up to three times on one open. Reduce to one:

- Have the WS permission-reconcile and resume-cancel paths reuse a single
  in-memory read instead of each calling `load_history` independently, and/or
- Skip the redundant read-path `prepare_update_for_storage` normalization
  (already applied at write time) and avoid the extra full clone in the HTTP
  handler where a borrowing transform suffices.

- Cuts backend open cost ~3×→~1× for long, tool-heavy chats; pure server-side,
  no protocol/shape change to what the client receives.

## Out of scope (deferred — tracked for a later tranche)

Bigger, riskier structural work, to do only if measurement shows it's needed:

- **Real tail pagination** (load only the last N turns; fetch older on scroll-up)
  — the one fix that makes a 5,000-message chat open like a 50-message one.
- **Progressive / virtualized hot-zone mount.**
- **Measurement + scroll-positioning rework** (reflow storm, 12-frame loop).
- **Incremental derivations + default render windowing** (O(n²) → O(1) per token).

## Verification

- `cd grove-web && pnpm run build` (tsc + vite) and `eslint --max-warnings 0` green.
- `cargo check` / `cargo build --release` green.
- Perf monitor before/after on a long real chat: `/history` P95 (backend tab),
  MarkdownRenderer self-time (renders tab), and switch-to-first-paint on the
  timeline. Record the numbers here when measured.
- Behavioral: switching between chats still shows correct, current history;
  streaming a live turn still renders incrementally; permissions and resume-cancel
  still reconcile correctly after the backend change.
