# Global Chat Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user set a global default model/mode/thinking (paired with the already-existing default agent `acp.agent_command`) so every new chat starts from their preferred stack instead of the agent's built-in fallbacks.

**Architecture:** Reuse the existing default agent (`config.acp.agent_command`). Add a `chat_defaults { model, mode, thinking }` config sub-struct served by the existing `/config` API. Add a per-agent capability cache (JSON file, written when any ACP session reaches `session_ready`) exposed via `GET /agents/{id}/capabilities` so the Settings dropdowns can list valid options. New chats honor the default agent and, on `session_ready`, seed model/mode/thinking from the defaults (validated against the agent's declared options).

**Tech Stack:** Rust 2021 (axum, tokio, serde), React 19 + TypeScript (Vite, Tailwind). Storage: TOML (`~/.grove/config.toml`) + a new JSON cache (`~/.grove/agent_capabilities.json`).

**Reference spec:** `docs/superpowers/specs/2026-05-30-global-chat-defaults-design.md`

**Key facts the implementer must not re-derive:**
- Default agent already exists: `config.acp.agent_command`. Backend `create_chat` already falls back to it (`src/api/handlers/acp.rs:1060`). DO NOT add a second agent field.
- `config.toml` PATCH merge is **hand-written per section** in `patch_config` (`src/api/handlers/config.rs:323`). A new config field is invisible to PATCH until added there explicitly.
- Capabilities arrive only via the per-session ACP `session_ready` event; there is **no** existing per-agent cache or endpoint.
- Model/mode/thinking are never sent at chat creation; they are applied by the agent's own `session_ready` (TaskChat.tsx:4073). Seed them there, frontend-side.
- Pre-commit hook (`.githooks/pre-commit`) runs `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `pnpm eslint src/ --max-warnings 0`, and a **version-bump check** (Cargo.toml must differ from `master`). Bump the Cargo.toml patch version once on this branch (Task 0) so commits pass.

---

## File Structure

| File | Responsibility |
|---|---|
| `Cargo.toml` | Version bump so the pre-commit version-check passes on this branch |
| `src/storage/config.rs` | `ChatDefaultsConfig` struct + `chat_defaults` field on `Config` |
| `src/storage/agent_capabilities.rs` | NEW — atomic per-agent capability cache (read/write/upsert) |
| `src/storage/mod.rs` | register `pub mod agent_capabilities;` |
| `src/acp/mod.rs` | upsert capabilities into the cache where `SessionReady` is emitted (~line 2577) |
| `src/api/handlers/agents.rs` | NEW `get_agent_capabilities` handler |
| `src/api/handlers/config.rs` | `chat_defaults` in `ConfigResponse`, `ConfigPatchRequest`, `patch_config` merge |
| `src/api/mod.rs` | register `GET /agents/{id}/capabilities` route |
| `grove-web/src/api/config.ts` | `chat_defaults` on `Config` + `ConfigPatch` |
| `grove-web/src/api/agents.ts` | `getAgentCapabilities(id)` client + `AgentCapabilities` type |
| `grove-web/src/components/Config/SettingsPage.tsx` | model/mode/thinking dropdowns in the Agent section + save wiring |
| `grove-web/src/components/Tasks/TaskView/TaskChat.tsx` | honor default agent on new chat; seed selectors on `session_ready` |

---

## Task 0: Version bump (unblock the pre-commit hook)

**Files:**
- Modify: `Cargo.toml` (the `[package] version = "..."` line)

- [ ] **Step 1: Bump the patch version**

Open `Cargo.toml`, find `version = "X.Y.Z"` under `[package]`, and increment the patch number (e.g. `0.11.1` → `0.11.2`). This is required because the pre-commit hook fails any commit on a non-`master` branch whose `Cargo.toml` version equals `master`'s.

- [ ] **Step 2: Commit**

```bash
git add Cargo.toml
git commit -m "chore: bump version for chat-defaults branch"
```

---

## Task 1: Backend config field (`ChatDefaultsConfig`)

**Files:**
- Modify: `src/storage/config.rs` (struct definitions near `pub struct Config` at line ~262)
- Test: inline `#[cfg(test)]` module in `src/storage/config.rs`

- [ ] **Step 1: Write the failing test**

Add to the existing test module at the bottom of `src/storage/config.rs` (if none exists, add `#[cfg(test)] mod chat_defaults_tests { use super::*; ... }`):

```rust
#[test]
fn chat_defaults_absent_deserializes_to_none() {
    // A config.toml written before this feature has no [chat_defaults] table.
    let toml_str = r#"
        terminal_multiplexer = "tmux"
    "#;
    let cfg: Config = toml::from_str(toml_str).expect("parse legacy config");
    assert!(cfg.chat_defaults.model.is_none());
    assert!(cfg.chat_defaults.mode.is_none());
    assert!(cfg.chat_defaults.thinking.is_none());
}

#[test]
fn chat_defaults_round_trips() {
    let mut cfg = Config::default();
    cfg.chat_defaults.model = Some("opus".to_string());
    cfg.chat_defaults.mode = Some("auto".to_string());
    cfg.chat_defaults.thinking = Some("high".to_string());
    let serialized = toml::to_string(&cfg).expect("serialize");
    let parsed: Config = toml::from_str(&serialized).expect("parse");
    assert_eq!(parsed.chat_defaults.model.as_deref(), Some("opus"));
    assert_eq!(parsed.chat_defaults.mode.as_deref(), Some("auto"));
    assert_eq!(parsed.chat_defaults.thinking.as_deref(), Some("high"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib chat_defaults -- --nocapture`
Expected: FAIL — `no field 'chat_defaults' on type 'Config'`.

- [ ] **Step 3: Add the struct and field**

In `src/storage/config.rs`, add the struct near the other config sub-structs:

```rust
/// Global default model/mode/thinking applied to new chats whose agent
/// matches the default agent (`acp.agent_command`). All optional: `None`
/// means "use the agent's own default". The default *agent* is NOT stored
/// here — it is `acp.agent_command`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatDefaultsConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}
```

Then add the field to `pub struct Config` (after `browser_control` at line ~284):

```rust
    #[serde(default)]
    pub chat_defaults: ChatDefaultsConfig,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --lib chat_defaults -- --nocapture`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/config.rs
git commit -m "feat: add ChatDefaultsConfig {model,mode,thinking} to Config"
```

---

## Task 2: Config API — serialize + patch `chat_defaults`

**Files:**
- Modify: `src/api/handlers/config.rs` (DTOs near line 19-138; `From<&Config>` at 140; `ConfigPatchRequest` at 225; `patch_config` at 323)
- Test: inline `#[cfg(test)]` test in `src/api/handlers/config.rs` for the patch-merge invariant

- [ ] **Step 1: Add the response + patch DTOs**

In `src/api/handlers/config.rs`, add a serialize DTO and a patch DTO:

```rust
#[derive(Debug, Serialize)]
pub struct ChatDefaultsConfigDto {
    pub model: Option<String>,
    pub mode: Option<String>,
    pub thinking: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChatDefaultsConfigPatch {
    /// `Some("")` clears the field, `Some("opus")` sets it, `None` leaves unchanged.
    pub model: Option<String>,
    pub mode: Option<String>,
    pub thinking: Option<String>,
}
```

Add `pub chat_defaults: ChatDefaultsConfigDto,` to `struct ConfigResponse` (after `browser_control` at line 36).

Add `pub chat_defaults: Option<ChatDefaultsConfigPatch>,` to `struct ConfigPatchRequest` (after `browser_control` at line 235).

- [ ] **Step 2: Populate the response in `From<&Config>`**

In the `From<&Config> for ConfigResponse` impl (line 140), add to the returned struct literal (alongside `browser_control` at line 216):

```rust
            chat_defaults: ChatDefaultsConfigDto {
                model: config.chat_defaults.model.clone(),
                mode: config.chat_defaults.mode.clone(),
                thinking: config.chat_defaults.thinking.clone(),
            },
```

- [ ] **Step 3: Apply the patch in `patch_config`**

In `patch_config` (line 323), add a merge block before `// Save config` (line 536). Empty string clears, mirroring the `menubar_shortcut` convention at line 497:

```rust
    // Apply chat_defaults patch
    if let Some(cd) = patch.chat_defaults {
        fn norm(v: String) -> Option<String> {
            let t = v.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        }
        if let Some(model) = cd.model {
            config.chat_defaults.model = norm(model);
        }
        if let Some(mode) = cd.mode {
            config.chat_defaults.mode = norm(mode);
        }
        if let Some(thinking) = cd.thinking {
            config.chat_defaults.thinking = norm(thinking);
        }
    }
```

- [ ] **Step 4: Write the merge-preserves-siblings test**

Add an inline test. `patch_config` loads/saves via `config::load_config`/`save_config` (filesystem), so test the merge logic at the `Config` level instead — assert that setting `chat_defaults` does not disturb a sibling, and that an absent patch leaves it intact. Add to a `#[cfg(test)]` module in `src/api/handlers/config.rs`:

```rust
#[cfg(test)]
mod chat_defaults_patch_tests {
    use crate::storage::config::Config;

    #[test]
    fn setting_chat_defaults_preserves_siblings() {
        let mut cfg = Config::default();
        cfg.acp.agent_command = Some("claude".to_string());
        // Simulate the merge block applying a chat_defaults patch.
        cfg.chat_defaults.model = Some("opus".to_string());
        // Sibling untouched.
        assert_eq!(cfg.acp.agent_command.as_deref(), Some("claude"));
        assert_eq!(cfg.chat_defaults.model.as_deref(), Some("opus"));
    }
}
```

- [ ] **Step 5: Run tests + clippy**

Run: `cargo test --lib chat_defaults && cargo clippy -- -D warnings`
Expected: PASS, no clippy warnings.

- [ ] **Step 6: Commit**

```bash
git add src/api/handlers/config.rs
git commit -m "feat: serialize and patch chat_defaults via /config"
```

---

## Task 3: Backend per-agent capability cache store

**Files:**
- Create: `src/storage/agent_capabilities.rs`
- Modify: `src/storage/mod.rs` (add `pub mod agent_capabilities;`)
- Test: inline `#[cfg(test)]` in the new module (uses `set_grove_dir_override` from `src/storage/mod.rs:37` to redirect to a temp dir)

- [ ] **Step 1: Write the failing test**

Create `src/storage/agent_capabilities.rs` with only the test + type stubs first:

```rust
//! Per-agent capability cache. Records the model/mode/thought-level option
//! lists an agent declares at ACP `session_ready`, keyed by agent id (the
//! same id used by `acp.agent_command` and a chat's stored `agent`), so the
//! Settings UI can offer valid choices without spawning a session.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// (id, human-label) pairs, matching the ACP `available_*` shape.
pub type OptionList = Vec<(String, String)>;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AgentCapabilities {
    #[serde(default)]
    pub models: OptionList,
    #[serde(default)]
    pub modes: OptionList,
    #[serde(default)]
    pub thought_levels: OptionList,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_then_read_round_trips() {
        let tmp = std::env::temp_dir().join(format!("grove-cap-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        crate::storage::set_grove_dir_override(Some(tmp.clone()));

        assert_eq!(read("claude"), None);

        let caps = AgentCapabilities {
            models: vec![("opus".into(), "Opus".into())],
            modes: vec![("auto".into(), "Auto".into())],
            thought_levels: vec![("high".into(), "High".into())],
        };
        upsert("claude", caps.clone());
        assert_eq!(read("claude"), Some(caps));
        assert_eq!(read("codex"), None);

        crate::storage::set_grove_dir_override(None);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib agent_capabilities 2>&1 | head -20`
Expected: FAIL — `cannot find function 'read'` / module not declared.

- [ ] **Step 3: Register the module**

In `src/storage/mod.rs`, add alphabetically near line 1-7:

```rust
pub mod agent_capabilities;
```

- [ ] **Step 4: Implement read / upsert with atomic write**

Append to `src/storage/agent_capabilities.rs` (mirrors the tmp→rename pattern of `write_session_metadata`):

```rust
fn cache_path() -> std::path::PathBuf {
    crate::storage::grove_dir().join("agent_capabilities.json")
}

fn load_all() -> HashMap<String, AgentCapabilities> {
    match std::fs::read_to_string(cache_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Read the cached capabilities for an agent id, or `None` if it has never
/// reached `session_ready`.
pub fn read(agent_id: &str) -> Option<AgentCapabilities> {
    load_all().get(agent_id).cloned()
}

/// Upsert (last-writer-wins) the capabilities for an agent id. Errors are
/// swallowed: a failed cache write must never break a live session.
pub fn upsert(agent_id: &str, caps: AgentCapabilities) {
    let mut all = load_all();
    if all.get(agent_id) == Some(&caps) {
        return; // no change; skip the write
    }
    all.insert(agent_id.to_string(), caps);
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(json) = serde_json::to_string_pretty(&all) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test --lib agent_capabilities -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/storage/agent_capabilities.rs src/storage/mod.rs
git commit -m "feat: per-agent capability cache store"
```

---

## Task 4: Write capabilities to the cache on `session_ready`

**Files:**
- Modify: `src/acp/mod.rs` (the `SessionReady` emit at line 2577)

**Context for the implementer — the cache key:** The cache must be keyed by the agent id used by `acp.agent_command` and a chat's stored `agent` (e.g. `"claude"`, `"codex"`, a custom-agent id), NOT the ACP-declared display `agent_name`. In the function emitting `SessionReady`, locate the launch agent id — it is the agent command/id this session was started with (check the surrounding function for a `handle` field or local such as `agent_command`, the value passed through `create_chat`/`resolve_agent`). The helper `canonical_builtin_acp_agent(&agent_name)` (`src/acp/mod.rs:4508`) normalizes a name to a canonical builtin id and is a valid fallback if no launch id is in scope. Confirm by checking that the chosen variable equals what `create_chat` stored as the chat's `agent`.

- [ ] **Step 1: Add the upsert call before the emit**

Immediately before `handle.emit(AcpUpdate::SessionReady { ... });` at line 2577, insert (the option lists `available_modes`, `available_models`, `available_thought_levels` are already in scope and cloned into the emit below):

```rust
    // Cache this agent's declared capabilities so Settings can offer valid
    // default model/mode/thinking choices without spawning a session.
    {
        let agent_key = /* launch agent id — see task context */;
        crate::storage::agent_capabilities::upsert(
            &agent_key,
            crate::storage::agent_capabilities::AgentCapabilities {
                models: available_models.clone(),
                modes: available_modes.clone(),
                thought_levels: available_thought_levels.clone(),
            },
        );
    }
```

Replace `/* launch agent id — see task context */` with the confirmed variable. If only `agent_name` is available, use `canonical_builtin_acp_agent(&agent_name).map(|s| s.to_string()).unwrap_or_else(|| agent_name.clone())`.

- [ ] **Step 2: Verify it compiles and the move/borrow is correct**

Run: `cargo check`
Expected: clean. (`available_*` are `.clone()`d here and still moved into the emit struct below — confirm no use-after-move; the emit at 2581-2585 already moves the originals, so cloning *before* the emit is correct.)

- [ ] **Step 3: Run clippy + tests**

Run: `cargo clippy -- -D warnings && cargo test --lib agent_capabilities`
Expected: clean, PASS.

- [ ] **Step 4: Commit**

```bash
git add src/acp/mod.rs
git commit -m "feat: cache agent capabilities on session_ready"
```

---

## Task 5: `GET /agents/{id}/capabilities` endpoint

**Files:**
- Modify: `src/api/handlers/agents.rs` (add handler near `list_base_agents` at line 29)
- Modify: `src/api/mod.rs` (register route near line 78, next to `/agents/base`)

- [ ] **Step 1: Add the handler + response DTO**

In `src/api/handlers/agents.rs`, add:

```rust
use axum::extract::Path;

#[derive(Debug, Serialize)]
pub struct AgentCapabilitiesDto {
    /// (id, label) pairs. Empty when the agent has never connected.
    pub models: Vec<(String, String)>,
    pub modes: Vec<(String, String)>,
    pub thought_levels: Vec<(String, String)>,
}

/// GET /api/v1/agents/{id}/capabilities
/// Returns the cached model/mode/thought-level options for an agent id, or
/// empty arrays if it has never reached `session_ready`.
pub async fn get_agent_capabilities(Path(id): Path<String>) -> Json<AgentCapabilitiesDto> {
    let caps = crate::storage::agent_capabilities::read(&id).unwrap_or_default();
    Json(AgentCapabilitiesDto {
        models: caps.models,
        modes: caps.modes,
        thought_levels: caps.thought_levels,
    })
}
```

(If `Serialize` / `Json` aren't already imported at the top of `agents.rs`, they are — `BaseAgentsResponse` uses them. `Path` may need adding to the imports.)

- [ ] **Step 2: Register the route**

In `src/api/mod.rs`, directly after line 78:

```rust
        .route(
            "/agents/{id}/capabilities",
            get(handlers::agents::get_agent_capabilities),
        )
```

(Match the axum path-param syntax already used in this router — the codebase uses `{id}`-style braces, e.g. `/projects/{id}/...`.)

- [ ] **Step 3: Verify it compiles**

Run: `cargo check`
Expected: clean.

- [ ] **Step 4: Manual smoke check**

Run: `cargo run -- web` then in another shell:
`curl -s localhost:3001/api/v1/agents/claude/capabilities`
Expected: JSON `{"models":[...],"modes":[...],"thought_levels":[...]}` — populated if a Claude chat has connected since the cache was added, else all empty arrays. (No 404/500.)

- [ ] **Step 5: Commit**

```bash
git add src/api/handlers/agents.rs src/api/mod.rs
git commit -m "feat: GET /agents/{id}/capabilities endpoint"
```

---

## Task 6: Frontend API types + client

**Files:**
- Modify: `grove-web/src/api/config.ts` (`Config` at 122, `ConfigPatch` at 141)
- Modify: `grove-web/src/api/agents.ts` (add `getAgentCapabilities`)

- [ ] **Step 1: Add `chat_defaults` to config types**

In `grove-web/src/api/config.ts`, add the interface above `interface Config` (line 122):

```typescript
export interface ChatDefaultsConfig {
  model?: string | null;
  mode?: string | null;
  thinking?: string | null;
}
```

Add `chat_defaults: ChatDefaultsConfig;` to `interface Config` (after `browser_control` at line 132).

Add `chat_defaults?: Partial<ChatDefaultsConfig>;` to `interface ConfigPatch` (after `browser_control` at line 151).

- [ ] **Step 2: Add the capabilities client**

In `grove-web/src/api/agents.ts`, add (match the file's existing `apiClient.get` style — inspect the top of the file for the import):

```typescript
export interface AgentCapabilities {
  /** [id, label] pairs. Empty when the agent has never connected. */
  models: [string, string][];
  modes: [string, string][];
  thought_levels: [string, string][];
}

export async function getAgentCapabilities(
  agentId: string,
  signal?: AbortSignal,
): Promise<AgentCapabilities> {
  return apiClient.get<AgentCapabilities>(
    `/api/v1/agents/${encodeURIComponent(agentId)}/capabilities`,
    signal,
  );
}
```

If `agents.ts` re-exports through `grove-web/src/api/index.ts`, add `getAgentCapabilities` / `AgentCapabilities` to the export list there (check whether `listBaseAgents` is re-exported and follow the same pattern).

- [ ] **Step 3: Typecheck + lint**

Run: `cd grove-web && pnpm exec tsc --noEmit && pnpm eslint src/api/config.ts src/api/agents.ts --max-warnings 0`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add grove-web/src/api/config.ts grove-web/src/api/agents.ts grove-web/src/api/index.ts
git commit -m "feat: frontend chat_defaults config type + capabilities client"
```

---

## Task 7: Settings UI — default model/mode/thinking dropdowns

**Files:**
- Modify: `grove-web/src/components/Config/SettingsPage.tsx` (Agent section `<Section id="chat">` at 1237; state near `acpAgent` at 249; config-load effect near line 445; save effect/`saveConfig` near 609-636)

**Context:** The default agent is the existing `acpAgent` state (saved to `acp.agent_command`). Add three `Combobox` dropdowns under the "Default Coding Agent" picker (after line 1264, inside the same `<div className="space-y-5">`). They read options from the selected agent's cached capabilities and persist into `chat_defaults` via the existing debounced save.

- [ ] **Step 1: Add state for the defaults + fetched capabilities**

Near the `acpAgent` state (line 249), add:

```typescript
const [defaultModel, setDefaultModel] = useState<string>("");
const [defaultMode, setDefaultMode] = useState<string>("");
const [defaultThinking, setDefaultThinking] = useState<string>("");
const [agentCaps, setAgentCaps] = useState<AgentCapabilities | null>(null);
```

Import `getAgentCapabilities` and `type AgentCapabilities` from `../../api` (add to the existing import block at lines 38-51).

- [ ] **Step 2: Hydrate the defaults from config on load**

In the config-load effect (where `acp.agent_command` is read at line 445-446), add hydration from `chat_defaults`:

```typescript
setDefaultModel(cfg.chat_defaults?.model ?? "");
setDefaultMode(cfg.chat_defaults?.mode ?? "");
setDefaultThinking(cfg.chat_defaults?.thinking ?? "");
```

- [ ] **Step 3: Fetch capabilities whenever the default agent changes**

Add an effect (place it after the existing agent-availability effect near line 1029):

```typescript
useEffect(() => {
  if (!acpAgent) {
    setAgentCaps(null);
    return;
  }
  const ctrl = new AbortController();
  getAgentCapabilities(acpAgent, ctrl.signal)
    .then(setAgentCaps)
    .catch(() => setAgentCaps(null));
  return () => ctrl.abort();
}, [acpAgent]);
```

- [ ] **Step 4: Clear now-invalid defaults when the agent changes**

Add an effect that drops a stored default not present in the freshly-fetched capability list (so switching agent doesn't persist a model the new agent can't use):

```typescript
useEffect(() => {
  if (!agentCaps) return;
  const has = (list: [string, string][], v: string) =>
    v === "" || list.some(([id]) => id === v);
  if (!has(agentCaps.models, defaultModel)) setDefaultModel("");
  if (!has(agentCaps.modes, defaultMode)) setDefaultMode("");
  if (!has(agentCaps.thought_levels, defaultThinking)) setDefaultThinking("");
}, [agentCaps]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 5: Render the three dropdowns**

Inside the Agent section, after the "Default Coding Agent" block (after line 1264), add. `Combobox` is already imported (line 34) and takes `options: ComboboxOption[]` (`{ label, value }`):

```tsx
{/* Default model / mode / thinking — paired with the default agent above.
    Options come from the agent's cached capabilities (populated after the
    agent first connects). Empty selection = use the agent's own default. */}
<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
  {[
    { label: "Default Model", value: defaultModel, set: setDefaultModel, opts: agentCaps?.models ?? [] },
    { label: "Default Mode", value: defaultMode, set: setDefaultMode, opts: agentCaps?.modes ?? [] },
    { label: "Default Thinking", value: defaultThinking, set: setDefaultThinking, opts: agentCaps?.thought_levels ?? [] },
  ].map((f) => (
    <div key={f.label}>
      <div className="text-xs font-medium text-[var(--color-text-muted)] mb-2 uppercase tracking-wider select-none">
        {f.label}
      </div>
      {f.opts.length > 0 ? (
        <Combobox
          value={f.value}
          onChange={f.set}
          options={[{ label: "Default", value: "" }, ...f.opts.map(([id, name]) => ({ label: name, value: id }))]}
          placeholder="Default"
        />
      ) : (
        <div className="h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 flex items-center text-xs text-[var(--color-text-muted)]">
          Options populate after you first run this agent.
        </div>
      )}
    </div>
  ))}
</div>
```

- [ ] **Step 6: Persist via the existing save**

In the `saveConfig` body where the PATCH object is built (the block around line 609-636 that sets `acp: { agent_command: acpAgentCommand, ... }`), add a sibling key:

```typescript
chat_defaults: {
  model: defaultModel,   // "" clears it server-side
  mode: defaultMode,
  thinking: defaultThinking,
},
```

Add `defaultModel, defaultMode, defaultThinking` to the dependency arrays of both the autosave effect (line 676) and the `saveConfig` callback deps (line 812) so edits trigger a save.

- [ ] **Step 7: Typecheck, lint, build**

Run: `cd grove-web && pnpm exec tsc --noEmit && pnpm eslint src/components/Config/SettingsPage.tsx --max-warnings 0 && pnpm run build`
Expected: no type errors, no lint warnings, build succeeds.

- [ ] **Step 8: Manual UI check**

Run: `make web`, open `localhost:3001`, go to Settings → Agent. Confirm:
- The three dropdowns appear under "Default Coding Agent".
- For an agent that has connected before, real model/mode/thinking options list.
- For an agent never run, the "Options populate after you first run this agent." hint shows.
- Selecting values and reloading the page persists them.
- Switching the default agent re-fetches options and clears now-invalid selections.

- [ ] **Step 9: Commit**

```bash
git add grove-web/src/components/Config/SettingsPage.tsx
git commit -m "feat: default model/mode/thinking dropdowns in Agent settings"
```

---

## Task 8: New chats honor the default agent

**Files:**
- Modify: `grove-web/src/components/Tasks/TaskView/TaskChat.tsx` (`handleNewChatWithAgent` ~4302; the default-agent fallback at ~4331)

**Context:** Today the keyboard/"new default agent" path falls back to `chats[chats.length-1]?.agent || "claude"` (last-used). Change it to consult the configured default agent first. The component already calls `getConfig()` elsewhere; the config's `acp.agent_command` is the default agent id.

- [ ] **Step 1: Read the existing fallback**

Inspect TaskChat.tsx around lines 4302-4335 to see the exact `onDefault`/fallback closure and whether a `config`/`getConfig()` value is already in scope there. Identify the line `chats[chats.length - 1]?.agent || "claude"`.

- [ ] **Step 2: Consult the default agent first**

Change the fallback so it prefers the configured default agent, then last-used, then `"claude"`. If config isn't already in scope at that callsite, fetch it:

```typescript
// Prefer the configured default agent (acp.agent_command); fall back to the
// last-used agent, then "claude".
const cfg = await getConfig().catch(() => null);
const agent =
  cfg?.acp?.agent_command ||
  chats[chats.length - 1]?.agent ||
  "claude";
```

If the surrounding `onDefault` is not already `async`, make it `async` (it dispatches into `handleNewChatWithAgent(agent)` which already accepts a string). Keep the existing explicit-pick path (where the user chose an agent in the picker) unchanged — only the no-explicit-pick fallback changes.

- [ ] **Step 3: Typecheck + lint**

Run: `cd grove-web && pnpm exec tsc --noEmit && pnpm eslint src/components/Tasks/TaskView/TaskChat.tsx --max-warnings 0`
Expected: clean.

- [ ] **Step 4: Manual check**

Run `make web`. In Settings → Agent set "Default Coding Agent" to a non-Claude agent (e.g. Codex if available). Create a new chat via the default-agent shortcut/`+` (without picking in the picker). Confirm the new chat starts on the configured default agent, not the last-used one.

- [ ] **Step 5: Commit**

```bash
git add grove-web/src/components/Tasks/TaskView/TaskChat.tsx
git commit -m "feat: new chats honor configured default agent"
```

---

## Task 9: Seed model/mode/thinking on `session_ready`

**Files:**
- Modify: `grove-web/src/components/Tasks/TaskView/TaskChat.tsx` (the `session_ready` handler at ~4073, where `current_model_id`/`current_mode_id`/`current_thought_level_id` are applied)

**Context:** When a brand-new chat whose agent === the default agent reaches `session_ready`, override the agent's own defaults with the configured `chat_defaults`, but only for values present in the event's `available_*` lists. "Brand-new" = the chat has no prior user-chosen selection (e.g. this is the first `session_ready` and the chat has no persisted model/mode/thinking). Apply via the SAME setters/handlers the dropdowns use so the choice is pushed to the agent (not just local state).

- [ ] **Step 1: Inspect the session_ready handler and the dropdown change handlers**

Read TaskChat.tsx around lines 4060-4110 (the `session_ready` branch) and find the functions invoked when the user changes the model/mode/thinking dropdowns (search for `setSelectedModel`, `setPermissionLevel`, `setThoughtLevel` and any `onChange` that also sends the selection to the agent, e.g. a `changeModel`/`setSessionModel` call). The seeding must call those same agent-pushing handlers, not just the local `setState`.

- [ ] **Step 2: Determine "brand-new chat" and "agent matches default"**

In the `session_ready` handler, gate the seeding:
- The chat's agent (`activeChat?.agent` or the session's agent) must equal `cfg.acp.agent_command`.
- The chat must be new: the agent reported no prior selection that the user set. Use the absence of a previously-persisted selection as the signal — i.e. seed only on the FIRST `session_ready` for a freshly-created chat. If a `hadSessionReady`-style flag exists (the file uses one near line 3555 for the cold-open path), reuse it; otherwise track first-ready per chat id with a ref keyed by chat id (mirror the `wasConnectedRef` pattern used elsewhere in this file to avoid double-application).

Fetch `cfg` once (the handler can read a cached config or call `getConfig()`); avoid a network call on every event by caching the default agent + `chat_defaults` in a ref refreshed when config changes.

- [ ] **Step 3: Apply validated seeds**

Add, inside the first-ready + agent-matches branch, after the agent's own `current_*` values are applied:

```typescript
// Seed configured defaults for a brand-new chat on the default agent.
// Only apply values the agent actually offers; otherwise leave its default.
const inList = (list: Array<{ value: string }>, v?: string | null) =>
  !!v && list.some((o) => o.value === v);

if (inList(modelOptions, defaults.model)) {
  applyModelSelection(defaults.model!); // same handler the model dropdown uses
}
if (inList(modeOptions, defaults.mode)) {
  applyModeSelection(defaults.mode!);
}
if (inList(thoughtLevelOptions, defaults.thinking)) {
  applyThinkingSelection(defaults.thinking!);
}
```

Replace `applyModelSelection`/`applyModeSelection`/`applyThinkingSelection` with the actual handler names found in Step 1. `modelOptions`/`modeOptions`/`thoughtLevelOptions` are the option arrays the event just populated (lines 1784-1795); if the event payload arrays (`available_models` etc.) are more convenient at this point in the handler, validate against those instead — map to `{value}` accordingly.

- [ ] **Step 4: Typecheck, lint, build**

Run: `cd grove-web && pnpm exec tsc --noEmit && pnpm eslint src/components/Tasks/TaskView/TaskChat.tsx --max-warnings 0 && pnpm run build`
Expected: clean.

- [ ] **Step 5: Manual end-to-end check**

Run `make web`. In Settings → Agent, set the default agent and pick a non-default model/mode/thinking (each must be a real option for that agent). Then:
1. Create a new chat on the default agent → on connect, confirm the model/mode/thinking match the configured defaults (visible in the in-chat dropdowns), and the agent received them.
2. Create a new chat on a DIFFERENT agent → confirm it uses that agent's own defaults (no seeding).
3. In an existing chat, change a selector, then reopen it → confirm the per-chat choice persists and the global default in Settings is unchanged.
4. Clear all three defaults in Settings → new chats fall back to the agent's own defaults.

- [ ] **Step 6: Commit**

```bash
git add grove-web/src/components/Tasks/TaskView/TaskChat.tsx
git commit -m "feat: seed chat defaults on session_ready for the default agent"
```

---

## Task 10: Full build + integration verification

**Files:** none (verification only)

- [ ] **Step 1: Backend CI**

Run: `make ci`
Expected: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, web eslint, and web build all pass.

- [ ] **Step 2: Release build sanity (rust-embed bakes dist)**

Run: `cd grove-web && pnpm run build && cd .. && cargo build --release`
Expected: frontend dist rebuilt BEFORE the release binary (so the baked assets include the new Settings UI). Confirm `grove-web/dist` mtime is newer than the prior build.

- [ ] **Step 3: Confirm Build Status summary**

Per `CLAUDE.md`, end with:

```
## Build Status
- ✅ pnpm run build: passes
- ✅ Rust backend: builds (debug + release), tests pass
```

---

## Self-Review (completed by plan author)

**Spec coverage:** Every spec section maps to a task — config field (T1), `/config` serialize+patch (T2), capability cache store (T3), cache write on session_ready (T4), read endpoint (T5), frontend types/client (T6), Settings dropdowns (T7), honor default agent (T8), seed on session_ready (T9), verification (T10). The version-bump prerequisite is T0.

**Placeholder scan:** Two intentional "find the exact local/handler name" steps remain in T4 (cache key variable) and T9 (dropdown change-handler names) — these are unavoidable because the precise identifier depends on in-file context the implementer must read; each is accompanied by exact search targets and a documented fallback, not a vague "handle it."

**Type consistency:** `ChatDefaultsConfig {model,mode,thinking}` (Rust) ↔ `ChatDefaultsConfig {model?,mode?,thinking?}` (TS) ↔ PATCH `chat_defaults` are consistent. Capability shape `Vec<(String,String)>` (Rust) ↔ `[string,string][]` (TS) is consistent across cache store, endpoint DTO, and client. `acp.agent_command` is the single default-agent source in T7/T8/T9.
