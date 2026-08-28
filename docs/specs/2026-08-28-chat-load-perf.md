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

### Option 3 — Trim the backend HTTP-handler passes (backend)

Original intent was to collapse the up-to-3× `load_history` per open to one.
Closer reading narrowed the *safe* scope:

- **Removed the full deep clone in `get_chat_history`** (`acp.rs:2595`): the old
  `history[offset..].iter().cloned().map(ServerMessage::from)` deep-cloned every
  retained event (up to 32 KB tool/terminal content each) just to feed the map.
  `ServerMessage::from` takes an owned `AcpUpdate`, so `into_iter().skip(offset)`
  transforms in place — one fewer full allocation of the whole history, zero
  behavior change. **Done.**

**Deferred as unsafe (documented so we don't retry them blindly):**

- *Skipping the read-path `prepare_update_for_storage`* — it is **not** redundant
  normalization; it is a live legacy-data migration (`chat_history.rs:134`,
  `legacy_raw_input/output` → structured `input`/`output`). Dropping it would
  break rendering of tool calls in older on-disk histories.
- *Sharing one read across the WS permission-reconcile (`acp.rs:1054`) and
  resume-cancel (`acp.rs:818` → `cancel_unresolved_events`) paths* — `cancel`
  **writes** synthetic cancellation events and the reconcile must read the
  post-write state, so a single pre-cancel read would be incorrect. A true
  3×→1× needs a cache with invalidation — bigger, riskier, out of this tranche.

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

## Tranche 2 — implemented 2026-08-28

Chosen sub-item: **default render windowing** (the O(total)-derivation fix),
built measure-first. The other tranche-2 items (tail pagination, progressive
hot-zone mount, scroll-positioning rework) stay deferred — see the assessment
below.

### Why windowing is the fix

`buildRenderItems` (render-item list) and `buildConversationTurns` (minimap) are
recomputed from scratch over the **whole** `messages` array on every change
(`useMemo([messages, isBusy])`). While an assistant streams, each token yields a
new `messages` reference → both memos rebuild over the entire history, so a
streaming turn costs **O(history × tokens)**. A render window bounds the derived
(and mounted) set, making the per-token cost flat regardless of conversation
length. The projection is turn-local — a completed turn's render items depend
only on that turn's own messages — so slicing off older turns never changes the
tail (locked by a test).

### Measurement (autonomous, pre-change)

From `taskChatRenderItems.test.ts` "derivation cost profile" (jsdom on the dev
box; relative shape is the point, not absolute ms):

```
   50 turns (  200 msgs)  build=0.6ms   streamReplay(40 tok)= 29ms
  200 turns (  800 msgs)  build=2.2ms   streamReplay(40 tok)= 48ms
  800 turns ( 3200 msgs)  build=4.3ms   streamReplay(40 tok)=208ms
 2000 turns ( 8000 msgs)  build=7.3ms   streamReplay(40 tok)=171ms
```

A single from-scratch build grows with total history, and the chat pays one such
build **per streamed token** — so a 40-token reply on a 3k-message chat burns
~200ms of main-thread work in derivations alone. Bounding the input at
`DEFAULT_CHAT_RENDER_WINDOW_LIMIT = 600` (prune trigger 1100) holds each build in
the ~2ms band no matter how long the chat gets. (Frontend React-profiler
before/after on a real long chat still wants an interactive `PERF=1` session.)

### Changes

1. **Extraction (no behavior change).** Moved the chat message model
   (`chatMessageTypes.ts`) and the pure projection builders
   (`taskChatRenderItems.ts`: `buildRenderItems`, `buildConversationTurns`,
   `renderItemKey`, `normalizeToolVerb`, `isEditTool`, …) out of the ~14k-line
   `TaskChat.tsx` into colocated, unit-tested modules — matching the repo's
   `foo.ts` + `foo.test.ts` convention and unblocking measurement.
2. **Default render window ON** (`chatRenderWindow.ts`).
   `normalizeChatRenderWindowSettings` now distinguishes an **unset**
   `render_window_limit` (→ default 600 / trigger 1100) from an explicit **0**
   (→ disabled / unbounded, the opt-out is preserved — both used to collapse to
   0). Chats past ~1100 messages drop their oldest turns from the *view* only;
   the existing "N earlier messages are hidden" banner already communicates this
   and the full history stays on disk / served by the history API.
   `pruneChatViewMessages` (already wired on the load + live-stream paths) is now
   generic and reused unchanged.

Tests: `taskChatRenderItems.test.ts` (projection golden + turn-locality +
cost profile) and `chatRenderWindow.test.ts` (defaulting rules, opt-out,
prune math). All 75 TaskView suite tests pass; tsc + eslint clean.

### Incremental derivations — implemented 2026-08-28

`buildRenderItems` refactored into a restartable core (`buildRenderItemsFrom`,
which takes a start cursor and reports the last turn's boundary) plus
`buildRenderItemsIncremental(messages, isBusy, cache)`. The cache holds the prior
result and the last turn's `{startCursor, startItems}`; a build reuses every
completed turn's items and rebuilds only the streaming turn — O(last turn) per
token instead of O(history). A reference-equality check on the reusable prefix
falls back to a full rebuild on any prefix change (an edit, a front-prune that
shifts indices, or a chat switch). It is idempotent, so React StrictMode /
concurrent double-invoke is safe (a mismatch only ever costs a full rebuild).

Wired into `TaskChat` behind a `useRef` cache (reset on `activeChatId` change).
The projection stays byte-identical to the batch builder — proven by a seeded
400-step randomized append/stream/complete/prune equivalence test plus targeted
transition tests (`taskChatRenderItems.test.ts`).

Measured (streaming 60 tokens onto a fresh turn atop N prior turns):

```
  200 prior turns   batch= 29ms   incremental= 3.0ms   ( 9.6× faster)
  800 prior turns   batch=112ms   incremental= 5.4ms   (20.7× faster)
 2000 prior turns   batch=287ms   incremental=11.9ms   (24.1× faster)
```

This matters most for the unbounded opt-out (`render_window_limit: 0`), where the
render window provides no bound — incremental keeps streaming flat regardless.
`buildConversationTurns` (the minimap) is left batch: it is lighter (single
forEach, no slicing) and the render window already bounds its input.
