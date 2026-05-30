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

## Decisions locked during brainstorming + planning investigation

1. **Explicit global defaults in Settings** (not remember-last-used).
2. **One default stack**: a single `{ agent, model, mode, thinking }` tuple. When a chat's agent matches the default agent, all four seed; when the user manually switches a chat to a *different* agent, that agent's built-in defaults apply (the stored model wouldn't be valid for it).
3. **Capability source = cache-on-connect**: agent model/mode/thinking option lists are declared by the agent at ACP session init. Persist that capability set keyed by agent id whenever a session initializes; the Settings panel reads the cache to populate dropdowns. No subprocess spawn on Settings open, no hardcoded lists that rot.

### Grounded decisions (from planning-phase code investigation)

The "first planning task" (verify capability sourcing) is resolved. Findings:

- **The default *agent* already exists** as `config.acp.agent_command` — the Settings "Default Coding Agent" picker writes here, and the backend `create_chat` handler (`src/api/handlers/acp.rs:1060`) already falls back to it. **Decision: reuse `acp.agent_command` as the default agent.** The new config struct stores only `{ model, mode, thinking }` — no separate agent field — to avoid two competing "default agent" sources.
- **The frontend new-chat path ignores the configured default agent.** `handleNewChatWithAgent`'s no-pick fallback is `chats[chats.length-1]?.agent || "claude"` (last-used), not `acp.agent_command` (TaskChat.tsx:4331). **Decision: fix this fallback to honor `acp.agent_command`**, so the configured default agent is actually applied to new chats. This directly addresses the original complaint.
- **No per-agent capability cache or endpoint exists.** Capabilities arrive only via the per-session ACP `session_ready` event (TaskChat.tsx:4073) and are persisted per-chat in `session.json` (not per-agent). **Decision: add a small per-agent capability cache** written when `session_ready` is emitted, read by a new endpoint.
- **Model/mode/thinking are never sent at chat creation** — they're applied by the agent's own `session_ready`. **Decision: seed them frontend-side right after `session_ready`** (validated against the agent's declared option lists), not via a backend `CreateChatRequest` change.

## Revision 2026-05-30b — per-agent defaults (post-deploy test feedback)

The v1 "one flat stack" stored a single `{model, mode, thinking}` tuple. Live testing exposed three bugs rooted in that single tuple being shown under a multi-agent picker:
1. **Leak** — the one tuple displayed under whichever agent was selected (Claude's values showed under Codex).
2. **Reset** — switching agents ran a "clear-invalid" effect whose cleared values were autosaved, destroying the previous agent's stored defaults; switching back didn't restore them (config was read only on mount).
3. **Free-typing** — `Combobox` (`Combobox.tsx:42`) flips into a text-input "custom mode" whenever `value ∉ options`; the leaked stale value triggered it. The control must be a strict dropdown.

**Resolution: defaults are now PER-AGENT.** Storage changes from a single tuple to a map keyed by agent id: `chat_defaults: { [agentId]: { model, mode, thinking } }`. Each agent remembers its own; switching the Settings picker shows that agent's saved values (or empty) and never clobbers another. New chats seed from **their own agent's** stored defaults (any agent, not only the default agent). `Combobox` gets `allowCustom={false}` AND its `isCustomMode` init is guarded by `allowCustom` so it can never become typeable.

The sections below are superseded where they describe a single flat `{model,mode,thinking}`; read them as per-agent map entries.

## Architecture

### Backend — config field

`src/storage/config.rs`:
- New struct `ChatDefaultsConfig { model: Option<String>, mode: Option<String>, thinking: Option<String> }` (all `Option`, `#[serde(default)]`). **No `agent` field** — the default agent is `acp.agent_command`.
- Add `#[serde(default)] pub chat_defaults: ChatDefaultsConfig` to the top-level `Config` struct (line ~262).
- All fields optional → existing `config.toml` files deserialize unchanged; unset = today's fallbacks.
- **No new HTTP route for config**: extend `ConfigResponse` (serialize), `ConfigPatchRequest` (a `chat_defaults: Option<ChatDefaultsConfigPatch>`), and the `patch_config` partial-merge body — following the exact per-section pattern already used for `acp`, `notifications`, etc. (`src/api/handlers/config.rs:323`). The merge is hand-written per field, so `chat_defaults` must be added to it explicitly; `Some("")` clears a field, `Some(value)` sets it.

### Backend — capability cache (confirmed: none exists, build it)

Investigation confirmed **no per-agent capability cache or endpoint exists**. Capabilities live only in per-chat `session.json` and the transient `session_ready` event. Build a small per-agent cache:
- **Store**: a JSON file `~/.grove/agent_capabilities.json` mapping `agent_id -> { models, modes, thought_levels }` (each a `Vec<(String, String)>` of `(id, label)`), written atomically (tmp → rename), mirroring `write_session_metadata` (`src/acp/mod.rs:4158`). New module `src/storage/agent_capabilities.rs`.
- **Write hook**: where `AcpUpdate::SessionReady` is emitted (`src/acp/mod.rs:~2577`), also upsert the agent's `{ available_models, available_modes, available_thought_levels }` into the cache keyed by the session's agent id. Last-writer-wins; cheap.
- **Read endpoint**: `GET /api/v1/agents/{id}/capabilities` in `src/api/handlers/agents.rs`, returning the cached set or empty arrays for an agent that has never connected. Register in `src/api/mod.rs` next to `/agents/base`.

### Frontend — Settings panel

Extend the **existing "Agent" Settings section** (`SettingsPage.tsx`, `<Section id="chat">` at line 1237), directly under the "Default Coding Agent" picker — not a brand-new top-level panel. The default agent is the existing `acpAgent` state (`acp.agent_command`).
- **Model / Mode / Thinking** dropdowns (`Combobox`) — populated by fetching `GET /agents/{acpAgent}/capabilities`. Re-fetch whenever `acpAgent` changes.
- Empty-state when the agent has never connected: show just a "Default" option + hint *"Options populate after you first run this agent."*
- When `acpAgent` changes, clear any stored model/mode/thinking that aren't valid for the new agent's capability set.
- Save → `PATCH /config` with `{ chat_defaults: { model, mode, thinking } }`, folded into the existing `saveConfig` debounced PATCH that already persists `acpAgent`.

### Frontend — chat-creation resolution

In `TaskChat`:
- **Honor the default agent**: `handleNewChatWithAgent`'s no-explicit-pick fallback (TaskChat.tsx:4331) changes from `chats[chats.length-1]?.agent || "claude"` to consult `config.acp.agent_command` first, then fall back to last-used, then `"claude"`.
- **Seed model/mode/thinking**: in the `session_ready` handler (TaskChat.tsx:4073), when the chat is brand-new (no prior `current_model_id` from the agent) AND its agent === `config.acp.agent_command`, override `selectedModel`/`permissionLevel`/`thoughtLevel` with `chat_defaults.{model,mode,thinking}` — but only for values that exist in the event's `available_*` option lists (validate; skip invalid). Apply via the same setters the dropdowns use so the choice is pushed to the agent.
- When the chat's agent differs from the default agent, seed nothing — the agent's own `session_ready` defaults stand (unchanged behavior).
- Any per-chat selector change overrides locally and never writes back to the global default.

## Data flow

```
Settings (Agent section):
  user picks default agent A  → PATCH /config { acp: { agent_command: A } }   (existing)
  user picks model M / mode D / thinking T for A
    → PATCH /config { chat_defaults: { model: M, mode: D, thinking: T } }
    → persisted to ~/.grove/config.toml

New chat created (no explicit agent pick):
  chat.agent = config.acp.agent_command ?? last-used ?? "claude"

On session_ready for that new chat:
  if chat.agent === config.acp.agent_command AND chat is brand-new:
     selectedModel    = chat_defaults.model    if in available_models     else agent default
     permissionLevel  = chat_defaults.mode     if in available_modes      else agent default
     thoughtLevel     = chat_defaults.thinking if in available_thought... else agent default
  else:
     use agent's own session_ready defaults (unchanged)

Per-chat override:
  user changes a selector → local chat state only; global default untouched

Capability population (Settings dropdowns):
  any session reaches session_ready → upsert { models, modes, thought_levels } keyed by agentId
    into ~/.grove/agent_capabilities.json
  Settings fetches GET /agents/{A}/capabilities → populates dropdowns
  no cache yet → "Default" only + hint
```

## Error handling

| Failure | Behavior |
|---|---|
| `config.toml` has no `chat_defaults` (pre-feature config) | `#[serde(default)]` → all `None` → today's fallbacks. No migration needed. |
| `acp.agent_command` references an agent no longer installed | Backend `create_chat` already falls back to `"claude"`; Settings picker already surfaces availability. Unchanged behavior. |
| `chat_defaults.model` invalid for the agent (agent updated, model removed) | `session_ready` seeding validates against `available_models` and skips invalid values → agent's own default stands; no error. |
| Capability cache empty for the chosen default agent | Settings dropdowns show "Default" + hint; saving nothing (all `None`) is always valid. |
| `PATCH /config` merge must include `chat_defaults` | The merge is hand-written per section; the new field must be added explicitly. Covered by a merge-preserves-siblings unit test. |

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
| `src/storage/config.rs` | new `ChatDefaultsConfig { model, mode, thinking }` struct + `chat_defaults` field on `Config` |
| `src/api/handlers/config.rs` | add `chat_defaults` to `ConfigResponse`, `ConfigPatchRequest`, and the `patch_config` per-section merge |
| `src/storage/agent_capabilities.rs` | NEW — per-agent capability cache (atomic JSON read/write keyed by agent id) |
| `src/acp/mod.rs` | on `SessionReady` emit, upsert agent capabilities into the cache |
| `src/api/handlers/agents.rs` + `src/api/mod.rs` | NEW `GET /agents/{id}/capabilities` endpoint + route registration |
| `grove-web/src/api/config.ts` | add `chat_defaults` to `Config` + `ConfigPatch` types |
| `grove-web/src/api/agents.ts` | add `getAgentCapabilities(id)` client + types |
| `grove-web/src/components/Config/SettingsPage.tsx` | model/mode/thinking dropdowns in the existing Agent section + save wiring |
| `grove-web/src/components/Tasks/TaskView/TaskChat.tsx` | honor default agent in new-chat fallback; seed selectors on `session_ready` when agent matches |

Reuses the existing default agent (`acp.agent_command`); the capability cache is the only net-new backend subsystem.
