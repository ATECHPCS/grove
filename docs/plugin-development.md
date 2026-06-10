# Grove Plugins — Developer Guide

A Grove plugin is a folder with a `plugin.json` manifest. It can contribute a
**panel**, a **sidebar page**, **skills**, an **MCP server**, and/or a **node
backend**, and reads context + persists data through a **typed SDK**.

## Quick start

**Settings → Plugins → Develop Plugin** → name it → pick a folder. Grove
scaffolds a vite + TypeScript project and registers it as a *dev* plugin. Then:

```
npm install      # install dev deps
npm run dev      # watch + rebuild panel AND server/backend — hit Reload in the panel
npm run build    # clean production build (panel + any server/backend)
npm run publish  # build + verify + package <name>-<version>.zip, ready to ship
```

`npm run publish` (or `make publish`) is the last step before distribution: it
checks every declared entry is built, then zips the install-only files
(`plugin.json` + `dist/` + `skills/` + `docs/`) into `<name>-<version>.zip` —
drop that into Grove → Settings → Plugins → Add → From Local. For a git install,
just commit `dist/`. The panel entry is `dist/index.html`.

> **Node 24+ required for backends.** A plugin that ships an MCP server or a
> node backend runs that process under Node's Permission Model (stable in node
> 24). Grove **refuses to launch** such a process on older node, so a declared
> permission is never silently unenforced. Pure-panel plugins have no node
> requirement (they run in the browser).

## Anatomy

```
my-plugin/
├── plugin.json          # manifest
├── package.json · vite.config.ts · Makefile · tsconfig.json
├── index.html           # vite entry
├── src/
│   ├── main.ts          # your panel UI
│   ├── shared.ts        # types/constants shared by panel + MCP/backend
│   └── grove-sdk/       # vendored SDK — refresh via Settings → Plugins → Update SDK
│       ├── index.ts     # panel SDK     → import { grove } from "./grove-sdk"
│       ├── mcp.ts       # MCP SDK       → import { grove } from "./grove-sdk/mcp"
│       └── backend.ts   # backend SDK   → import { … } from "./grove-sdk/backend"
├── dist/                # built, shipped output
├── skills/              # each subfolder with a SKILL.md → a Grove skill
└── docs/
```

## Manifest (`plugin.json`)

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "icon": "icon.png",
  "permissions": ["storage:read", "storage:write", "project:read"],
  "contributes": {
    "panel":   { "title": "My Plugin", "entry": "dist/index.html", "side": "right", "shortcut": "Mod+Alt+p" },
    "sidebar": { "title": "My Plugin", "entry": "dist/index.html" },
    "mcp":     { "command": "node", "args": ["dist/server.js"], "env": { "FOO": "bar" } },
    "backend": { "command": "node", "args": ["dist/backend.js"] }
  }
}
```

- **icon** *(optional)* — a square image shipped in the plugin (`"icon.png"`,
  `"assets/icon.svg"`; served via `/asset`) or an emoji (`"🧩"`). Shown in the
  sidebar, panel tab, and plugin list. Omit for a default puzzle glyph.
- **permissions** — what the SDK / node processes are allowed to do (see
  *Permissions*).
- **contributes.panel** — a workspace panel (task-scoped). `side`: `"left"`
  (aux) or `"right"` (info) column in IDE Layout. `shortcut`: optional default
  keybinding, user-reconfigurable in Settings → Shortcuts.
- **contributes.sidebar** — a top-level page (app-scoped).
- **contributes.mcp** — a stdio MCP server exposing tools to the **AI agent**.
- **contributes.backend** — a node process your **panel** talks to (see
  *Backend*). Independent of `mcp`: ship either, both, or neither.

## Panel SDK — `grove` (typed)

Import from `src/grove-sdk` in your panel code. Every call is a typed Promise.
The panel runs in a **fully isolated** sandboxed iframe (opaque origin) — it
cannot touch Grove or the filesystem except through this SDK.

```ts
import { grove } from "./grove-sdk";

const info = await grove.host.getInfo();
// { projectId, projectName, projectType: "repo"|"studio"|null, taskId }
```

### Storage — three scopes, KV + files

Each scope (`global` / `project` / `task`) has both a KV store (auto-JSON) and
file operations. Requires `storage:read` / `storage:write`.

```ts
// KV (the easy path)
await grove.storage.global.set("apiKey", "sk-…");   // cross-project
const key = await grove.storage.global.get<string>("apiKey");
await grove.storage.project.set("config", { theme: "dark" });  // this project
await grove.storage.task.set("draft", { body: "…" });          // this task only

// Files (when you need paths, binary, or listing)
await grove.storage.project.writeFile("cache/index.json", JSON.stringify(x));
const text  = await grove.storage.project.readFile("cache/index.json"); // string | null
const names = await grove.storage.project.list("cache");               // { name, isDir }[]
await grove.storage.task.writeBytes("thumb.png", bytes);               // Uint8Array
```

| Scope | Lives as long as | Use for |
|---|---|---|
| `global` | the plugin is installed | user prefs, auth tokens |
| `project` | the project exists | config, index caches |
| `task` | the task exists | drafts, transient state |

### Project files — read the current task

`project:read`, workspace panel only. Read-only.

```ts
const src = await grove.project.readFile("src/main.rs");   // string | null
const dir = await grove.project.list("src");               // { name, isDir }[]
```

### Chat — list sessions & inject prompts

Workspace panels only. The host scopes every call to **this panel's task** — a
plugin can't drive another task's agent.

```ts
// chat:read — the task's chat sessions, and which one the user has focused.
const chats = await grove.chat.list();          // ChatInfo[] {id,title,agent}
const active = grove.chat.activeChatId();        // string | null (read at call time)

// chat:write — inject a user prompt into a chat's agent (spawns the session on
// demand). It appears in the chat as a message from your plugin.
if (active) await grove.chat.sendPrompt({ chatId: active, text: "run the tests" });
```

> `chat:write` lets the plugin *drive the AI*; `chat:read` lets it *observe the
> AI's activity* (see `grove:radio` under Events). Both are flagged high-risk.

### exec — run a command (high-risk)

Stream a command's output from the task's working directory. Requires the
`exec` permission.

```ts
for await (const ev of grove.exec("go", ["test", "./..."])) {
  if (ev.type === "stdout") console.log(ev.line);
  else if (ev.type === "exit") console.log("exit", ev.code);
}
```

> `exec` is the **nuclear** permission: a spawned OS process is unsandboxable,
> so granting it is effectively full machine trust. Grove locks the working
> directory to the task root and caps runtime, but those are guardrails, not a
> security boundary. Use it only when you must.

### Backend — call your node process

If the plugin contributes a backend, the panel calls its methods:

```ts
const result = await grove.backend.invoke<{ rows: number }>("query", { sql: "…" });
```

### Theme

The SDK applies Grove's theme to your `:root` automatically (so `var(--color-bg)`
etc. match Grove and follow theme switches). `grove.theme.getColors()` /
`isLight()` / `onChange(cb)`.

### Utilities

`grove.util.uuid()` returns a collision-free UUID (wraps `crypto.randomUUID()`).
Available identically on the panel and MCP/backend sides — don't hand-roll one
from `Date.now()`/`Math.random()`.

### Sharing code between panel and server

The panel (browser build) and a server (node build) are separate bundles, but
they can `import` the same source. Put shared **types and constants** in
`src/shared.ts` and import from both — define them once instead of copy-pasting:

```ts
// src/shared.ts
export const STATE_KEY = "state";
export interface PluginState { count: number }

// src/main.ts (panel)            // src/server.ts (MCP)
import { STATE_KEY, type PluginState } from "./shared";
const s = await grove.storage.global.get<PluginState>(STATE_KEY);
```

The scaffold ships a `src/shared.ts` wired into `src/main.ts` as a starting point.

## MCP SDK — same `grove` API

Your MCP server uses the **same `grove` API** as the panel (from
`src/grove-sdk/mcp`) — identical shape, transport hidden.

```ts
import { grove } from "./grove-sdk/mcp";

const info  = await grove.host.getInfo();   // + taskName, branch
const src   = await grove.project.readFile("src/main.rs");
await grove.storage.global.set("token", "…");
```

### Real filesystem — `grove.paths`

The MCP server is a **host process with real filesystem access**, so for
anything heavier — a SQLite db, appended writes, search — use `grove.paths.*`
(raw dirs) with native Node libraries:

```ts
import { grove } from "./grove-sdk/mcp";
import { DatabaseSync } from "node:sqlite";      // built-in — no native addon
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

// A SQLite db in your global storage scope:
const db = new DatabaseSync(join(grove.paths.storage.global, "data.sqlite"));

// Incremental write (no full rewrite):
await appendFile(join(grove.paths.storage.global, "log.ndjson"), line + "\n");
```

`grove.paths` = `{ storage: { global, project, task }, project, plugin }`.
(The **panel** has no equivalent — it's an isolated iframe; do heavy data work
in the MCP server or backend, and have the panel read results via the SDK.)

Prefer Node's built-in **`node:sqlite`** over native addons like
`better-sqlite3`: the permission model blocks native addons by default, and the
built-in needs no `--allow-addons`. Running external tools (ripgrep, git) needs
the `exec` permission (`--allow-child-process`); plain fs does not.

### Testing a server offline

The SDK reads its context from the `GROVE_CONTEXT` env var that Grove injects.
To run a server **without launching Grove**, set it yourself — point storage at
a scratch dir and pipe a JSON-RPC line in:

```sh
export GROVE_CONTEXT='{"storage":{"global":"/tmp/p","project":null,"task":null},"projectDir":"'"$PWD"'","pluginDir":"'"$PWD"'","projectId":null,"taskId":null}'
echo '{"id":1,"method":"ping","params":{}}' | node dist/backend.js
```

`grove.storage.*` then reads/writes under `/tmp/p`, and `grove.paths.*` resolve
to the dirs you passed — enough to exercise handlers before wiring into Grove.

## Backend (`contributes.backend`)

A backend is a node process your panel calls over Grove-mediated JSON-RPC. It
has the **same `grove`** context/storage/paths as the MCP server, plus a tiny
RPC server. One process runs per task (with that task's project access) and is
reaped when idle.

```ts
// src/backend.ts → built to dist/backend.js
import { grove, registerHandler, serve } from "./grove-sdk/backend";

registerHandler("query", async ({ sql }: { sql: string }) => {
  const dir = grove.paths.storage.project;
  // …run the query, return JSON-serializable data…
  return { rows: 42 };
});

serve();   // read stdin / write stdout — call once, after registering handlers
```

> stdout is the RPC channel — log with `console.error` (stderr), which Grove
> forwards to its log. A `console.log` would corrupt the protocol.
>
> Handlers run **concurrently** (each invoke is dispatched as it arrives), so if
> two can mutate the same file/KV key, serialize that yourself (e.g. an in-flight
> promise chain) — Grove doesn't queue calls for you.

## Events (server → panel, live)

When a tool or backend method changes data, push an event so the panel
refreshes — no polling, no manual reload. Grove relays it to the panel for the
**same task**.

Type the payload once in `src/shared.ts` and pass it as the type arg on both
sides — `emit` and `on` are generic, so the compiler checks both ends:

```ts
// src/shared.ts
export interface CasesChanged { count: number }

// MCP server / backend — after mutating data:
grove.events.emit<CasesChanged>("cases-changed", { count: cases.length });

// panel — `d` is typed { count: number }:
grove.events.on<CasesChanged>("cases-changed", (d) => reload(d.count)); // returns unsubscribe
```

Directions: **backend ⇄ panel** is full duplex (panel → backend via
`grove.backend.invoke`, backend → panel via events); **MCP → panel** is
emit-only (an MCP server can push events but can't receive them — its stdio is
the agent's channel). `emit` is fire-and-forget; events are scoped to the
current task. No transport setup — Grove injects it.

### `grove:radio` — Grove's own agent activity (chat:read)

Beyond your own events, the panel can subscribe to a reserved `grove:radio`
stream: Grove's aggregated, task-scoped agent/chat activity — the same signal
the Radio phone and menubar tray consume. Requires `chat:read`.

```ts
grove.events.on("grove:radio", (e) => {
  // e is a tagged RadioEvent: e.type is "chat_status" | "task_busy" | ...
  // chat_status carries status / prompt / final message / todo progress, etc.
  if (e.type === "chat_status") refresh(e);
});
```

It's panel-only (the backend doesn't receive it). If your backend needs to
react, have the panel relay it via `grove.backend.invoke`.

## Where a plugin opens

| Contribution | Surface | How to open |
|---|---|---|
| `panel` | Workspace panel (task-scoped) | task toolbar `[+]` menu, or its keybinding |
| `sidebar` | Top-level page (app-scoped) | the sidebar nav entry |

## Skills

Each subfolder under `skills/` that contains a `SKILL.md` (with `name` /
`description` frontmatter) is mounted into Grove's Skill module as the source
`plugin:<id>` — added on install, removed on uninstall.

## MCP tools

Declare `contributes.mcp` to expose tools to the AI agent. Just add
`src/server.ts` (import from `./grove-sdk/mcp`) — the scaffold's build bundles it
to `dist/server.js` automatically (via `scripts/build-server.mjs`), in both
`npm run dev` (watched) and `npm run build`. Then declare:

```jsonc
"mcp": { "command": "node", "args": ["dist/server.js"] }
```

- The build never wipes your server bundle — `vite` (panel) and `esbuild`
  (server) share `dist/` without clobbering (`emptyOutDir: false`).
- Relative paths in `command`/`args` resolve against the plugin folder.
- `command` must be on the user's PATH (e.g. `node`); the plugin list warns if
  it's missing, or if node is older than 24.
- Get context via the `grove` SDK, not env.

## Permissions

Permissions are **enforced**, not advisory. The panel iframe is isolated
(opaque origin) so the SDK is its only channel; node processes (mcp / backend)
run under Node's Permission Model with grants matching exactly what you declare.

| Permission | Grants | Risk |
|---|---|---|
| `storage:read` | read the plugin's storage (all scopes) | — |
| `storage:write` | write the plugin's storage | — |
| `project:read` | read the current task's working dir | — |
| `project:write` | write the current task's working dir | ⚠ high |
| `chat:read` | list chats + receive `grove:radio` agent activity | ⚠ high |
| `chat:write` | inject prompts into a chat's agent (`grove.chat.sendPrompt`) | ⚠ high |
| `exec` | run commands (`grove.exec` / `child_process`) | ⚠⚠ full machine trust |

A plugin can only use what it declares; high-risk permissions are flagged in the
plugin list and confirmed on install. Network access is **not** a Grove
permission — Node's model can't enforce it, so Grove doesn't pretend to.

## Keybindings

A `panel.shortcut` (or the user, in Settings → Shortcuts) binds a key to
`panel.plugin:<id>.open` — added on install, removed on uninstall.

## Installing

From **Settings → Plugins**:

- **Develop** — scaffold a new plugin (dev).
- **Add → From Local** — drop a `.zip` or pick a folder (copied into Grove).
- **Add → From Git** — clone a repo (optional subpath).
- **Add → Dev folder** — reference a folder in place (hot-reload).

`local`/`git` plugins live under `~/.grove/plugins/<id>` (files removed on
uninstall); `dev` plugins reference your folder (only the registry entry is
removed).
