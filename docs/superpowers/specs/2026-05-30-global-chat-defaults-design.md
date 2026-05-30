# Global Chat Defaults — Design

**Date:** 2026-05-30
**Branch:** `feat/chat-defaults` (off `master`)
**Scope:** Let the user set a global default agent + model + mode + thinking level, so every new chat starts from their preferred stack instead of the hardcoded `Default (recommended)` / `Auto` / `Default` fallbacks. Per-chat overrides still win.

## Problem

Grove has no global/workspace-level default for the agent/model/mode/thinking selectors. Each new chat starts at the agent CLI's built-in fallbacks (`""` → "Default (recommended)" model, "Auto" mode, "Default" thinking), and the agent must be picked fresh each time. A user with a consistent preferred setup (e.g. always Claude Code + Opus + high thinking) has to re-select it on every new chat/project. Verified absent: the top-level `Config` struct (`src/storage/config.rs:262`) has theme/layout/mcp/acp/hooks/etc. but no chat-defaults field; `TaskChat`'s `selectedModel` initializes to `""`.

## Goal

A Settings panel where the user picks one default "stack": agent + that agent's model + mode + thinking. New chats seed their initial selectors from it. Changing a selector on any individual chat overrides for that chat only; the global default is untouched.

## Non-goals (deferred)

- **Per-agent defaults** (a separate default model/mode/thinking remembered for *each* agent) — Phase 2 if desired. v1 stores one flat stack.
- **Remember-last-used / auto-sticky** behavior — explicitly rejected in favor of explicit settings.
- **Hard-pinning** — defaults only *seed* new chats; they never lock a chat's selectors.

## Decisions locked during brainstorming

1. **Explicit global defaults in Settings** (not remember-last-used).
2. **One default stack**: a single `{ agent, model, mode, thinking }` tuple. When a chat's agent matches the default agent, all four seed; when the user manually switches a chat to a *different* agent, that agent's built-in defaults apply (the stored model wouldn't be valid for it).
3. **Capability source = cache-on-connect**: agent model/mode/thinking option lists are declared by the agent at ACP session init. Persist that capability set keyed by agent id whenever a session initializes; the Settings panel reads the cache to populate dropdowns. No subprocess spawn on Settings open, no hardcoded lists that rot.

## Architecture

### Backend — config field

`src/storage/config.rs`:
- New struct `ChatDefaultsConfig { agent: Option<String>, model: Option<String>, mode: Option<String>, thinking: Option<String> }` (all `Option`, `#[serde(default)]`).
- Add `pub chat_defaults: ChatDefaultsConfig` to the top-level `Config` struct (line ~262).
- All fields optional → existing `config.toml` files deserialize unchanged; unset = today's hardcoded fallbacks.
- **No new HTTP route**: the existing `GET /config` and `PATCH /config` serialize/patch the whole `Config`, so `chat_defaults` rides along automatically. Verify the PATCH handler does a deep/partial merge (not whole-object replace) so a partial `{ chat_defaults: {...} }` patch doesn't wipe sibling config.

### Backend — capability cache

**First planning task: determine whether a capability cache already exists.** The in-chat model/mode/thinking dropdowns are populated today, so the data is sourced somewhere (likely the ACP `initialize` response surfaced to the frontend, possibly already persisted). Two outcomes:
- **If an existing cache/endpoint exists** → the Settings panel reads it; no backend cache work needed.
- **If not** → add a small per-agent capability cache: on ACP session init, persist the agent's declared `{ models, modes, thinking_levels }` keyed by agent id (SQLite table or a `config`-adjacent store). Expose via a read endpoint (e.g. `GET /agents/{id}/capabilities`) or fold into the existing `/agents/base` response.

This is the highest-uncertainty piece and is deliberately left for planning to pin down against the live code.

### Frontend — Settings panel

New panel under the AI / Settings section (follow the existing Settings panel pattern, e.g. `ShortcutSettingsPanel`):
- **Agent** dropdown — from `/agents/base` (built-in + custom agents).
- **Model / Mode / Thinking** dropdowns — populated from the selected agent's cached capabilities. Empty-state when the agent has never connected: show just "Default" + hint *"Options populate after you first run this agent."*
- Save → `PATCH /config` with `{ chat_defaults: { agent, model, mode, thinking } }`.
- A "Reset to built-in defaults" affordance that clears the fields (PATCH with nulls).

### Frontend — chat-creation resolution

In `TaskChat` (and the new-chat/new-task creation flow):
- New task/chat creation pre-selects `chat_defaults.agent` when set (instead of no/most-recent agent).
- When a chat's active agent === `chat_defaults.agent`, seed `selectedModel` / mode / thinking from the defaults instead of `""` / "Auto" / "Default".
- When the agent differs (user switched), fall back to that agent's built-in defaults — unchanged behavior.
- Any per-chat selector change overrides locally and does not write back to the global default.

## Data flow

```
Settings:
  user picks agent A + model M + mode D + thinking T
    → PATCH /config { chat_defaults: { agent: A, model: M, mode: D, thinking: T } }
    → persisted to ~/.grove/config.toml

New chat created:
  resolve agent:
    chat.agent = chat_defaults.agent ?? (existing fallback)
  resolve selectors:
    if chat.agent === chat_defaults.agent:
       selectedModel    = chat_defaults.model    ?? agent built-in
       selectedMode     = chat_defaults.mode     ?? agent built-in
       selectedThinking = chat_defaults.thinking ?? agent built-in
    else:
       use agent built-in defaults (unchanged)

Per-chat override:
  user changes a selector → local chat state only; global default untouched

Capability population (Settings dropdowns):
  agent session init → cache { models, modes, thinking } keyed by agentId
  Settings reads cache for the selected agent → populates dropdowns
  no cache yet → "Default" only + hint
```

## Error handling

| Failure | Behavior |
|---|---|
| `config.toml` has no `chat_defaults` (pre-feature config) | `#[serde(default)]` → all `None` → today's fallbacks. No migration needed. |
| `chat_defaults.agent` references an agent no longer installed | New-chat resolution falls back to the existing agent-selection logic; Settings shows the stale value with a "not currently available" hint. |
| `chat_defaults.model` invalid for the agent (agent updated, model removed) | Chat seeds the agent's built-in default instead; no error. Treat the stored value as a hint, not a guarantee. |
| Capability cache empty for the chosen default agent | Settings dropdowns show "Default" + hint; saving "Default" is always valid. |
| `PATCH /config` partial-merge bug wipes siblings | Guarded by the planning-phase verification that PATCH deep-merges. Add a test if the merge path is non-obvious. |

## Testing

- **Backend unit test**: `ChatDefaultsConfig` round-trips through serde; a `config.toml` lacking the field deserializes to all-`None`; PATCH merge preserves sibling config.
- **Manual**:
  1. Set defaults in Settings → reload → values persist.
  2. Create a new chat → confirm it opens with the default agent + model + mode + thinking.
  3. Switch that chat to a different agent → confirm it uses the other agent's built-in defaults (not the stored model).
  4. Change a selector on a chat → confirm the global default in Settings is unchanged.
  5. Set a default for an agent you've never run → confirm graceful empty-state, then run it once → confirm dropdowns populate.
  6. Clear defaults → confirm new chats revert to built-in fallbacks.

## File changes (estimate)

| File | Change |
|---|---|
| `src/storage/config.rs` | new `ChatDefaultsConfig` struct + field on `Config` |
| `src/api/handlers/config.rs` | verify PATCH deep-merge covers the new field (likely no change) |
| (capability cache) | TBD by planning — new cache + read path *only if* none exists |
| `grove-web/src/api/` config types | add `chat_defaults` to the TS config type |
| `grove-web/src/components/Config/` | new ChatDefaultsSettingsPanel |
| `grove-web/src/components/Tasks/TaskView/TaskChat.tsx` | seed selectors from defaults when agent matches |
| new-chat / new-task creation flow | pre-select default agent |

Backend change is small; the capability-cache question is the main scoping unknown for the plan phase.
