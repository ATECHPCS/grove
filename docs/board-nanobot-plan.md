# Grove Board + nanobot connector — plan

_Fork-local plan doc (not upstreamed). Replaces the earlier "Overture/Symphony-only"
approach with a **Grove-native** primary lane; Symphony/Linear is kept as a parallel
second lane. Last updated: 2026-08-24._

## Goal

Talk to nanobot about a bug → it lands as a card on a **native Kanban board inside
Grove** and **auto-dispatches an agent** in a git worktree that fixes it and opens a
PR. No third-party board hosting for the primary path.

```
                    ┌─────────── nanobot (voice / Telegram) ───────────┐
                    │  file_bug skill: transcribe + classify           │
                    └───────────────────┬───────────────────────────────┘
             well-specified? ───────────┴─────────── exploratory / multi-agent?
                    │                                         │
            SYMPHONY lane (kept)                        GROVE lane (new, primary)
         Linear issue → 1 Codex/issue        HMAC POST /api/v1/.../tasks/dispatch
         (Overture Komodo stack)              → card in PLANNED, agent auto-starts
         tasks #30–#37                         in a worktree → rides to DONE → PR
```

## Locked decisions

1. **Grove-native primary, Symphony kept parallel.** nanobot's classifier routes each
   bug to one lane. Codex survives as a Grove agent *type*, not a separate product.
2. **New top-level `board` mode** alongside Zen / Blitz / Graph (a distinct nav id, not
   a `TasksMode`).
3. **nanobot → Grove over direct REST**, authenticated by **HMAC to the mobile server
   (:3002)** — reuses `ServerAuth::hmac`; needs a pinned stable secret.
4. **Dorothy's model, Grove's dark skin.** Adopt Dorothy's columns, card anatomy, and
   "drag-to-Planned = dispatch" interaction; render in Grove's liquid-glass palette.

## Dorothy reference → Grove mapping

Reference: `github.com/Charlie85270/Dorothy` (Next.js + Electron; flat-JSON kanban +
`mcp-kanban`/`mcp-orchestrator`). We copy its **flow and card model**, not its code or
its cream/teal palette.

| Dorothy | Grove implementation |
|---|---|
| columns `backlog → planned → ongoing → done` (UI: TODO / PLANNED / IN WORK / COMPLETED) | new `board_column` TEXT + `board_order` INT on `tasks` |
| **drag → planned = auto-assign** (README + board subtitle) | drop into PLANNED calls `POST /api/v1/.../tasks/dispatch` |
| `ongoing`/`done` drag-locked; ongoing→ only to done | replicate: in-work cards can't be dragged, only Terminal / Stop |
| card: project chip, title (strike when done), desc, progress bar, labels(3+overflow), agent Bot icon, skills(Wrench), attach(Paperclip), Done/date | over Grove `Task` + `ChatSession`; also show Grove diff stats (`code_additions/deletions/files_changed`) |
| agent working = green pulse dot + green ring + progress; `waiting` = amber (needs input) | from `RadioEvent`/`ChatStatus`: busy → green pulse/ring; `permission_required` → amber "needs you" pill |
| column accents zinc/blue/amber/green | keep those Tailwind tokens on Grove dark skin |
| one agent per task-worktree, torn down on completion | one `ChatSession` per task; Grove already makes the worktree at task create |
| providers claude/codex/gemini/grok/opencode | Grove agent registry (claude/codex/gemini) |
| storage: flat JSON `~/.dorothy/kanban-tasks.json` | SQLite `~/.grove/grove.db` |
| `mcp-kanban` tools | **not rebuilt** — nanobot hits `/dispatch` directly |
| `kanban-automation` skill-match watcher | optional Phase 6 (Grove-side watcher) |
| Telegram/voice → Super Agent decides `create_task` | nanobot IS the "super agent": transcribes, classifies, calls `/dispatch` |

### Column semantics on Grove

| Column | Grove signal |
|---|---|
| **TODO** (`backlog`) | task row exists, no `ChatSession` |
| **PLANNED** (`planned`) | drop here → `/dispatch` (create_task + create_chat + auto-start) |
| **IN WORK** (`ongoing`) | `WorktreeStatus::Live` / `ChatStatus` busy — live via Radio WS |
| **COMPLETED** (`done`) | `WorktreeStatus::Merged` / archived / agent reports done |

"Needs review / permission_required" is a **card affordance** (amber pill on the IN WORK
card), not a 5th column — faithful to Dorothy's 4-column layout.

## Grounding — key files (from code map)

**Backend (`grove-fork/src`)**
- Schema: `storage/database.rs:148` (`tasks` table), index `:176`; `task_groups` `:193`
- Task struct + column list: `storage/tasks.rs:55` / `:136` (`TASK_COLUMNS`); persisted
  `TaskStatus` (Active/Archived only) `:48`; runtime `WorktreeStatus`
  `model/worktree.rs:7`
- API router (axum, `/api/v1`): `api/mod.rs:42`; task routes block `:479`; create
  `api/handlers/tasks/crud.rs:170` (hardcodes `"idle"` `:237`, fires
  `RadioEvent::GroupChanged` `:229`)
- Dispatch primitives: `operations/tasks.rs:510` (`create_task` + worktree),
  `api/handlers/acp.rs:1732` (`create_chat`)
- Live event bus: `api/handlers/walkie_talkie.rs:36` (`RadioEvent`), broadcast `:232`,
  WS `:452`
- Auth: `api/auth.rs:60` (`no_auth`), `:76` (`hmac`), middleware `:222`

**Web (`grove-fork/grove-web/src`)** — React 19 + Vite + Tailwind 4, no react-router
- Nav registry: `data/nav.ts` (`REPO_NAV_IDS`); page switch `App.tsx:1213`
- Existing modes: Zen `components/Tasks/TasksPage.tsx`, Blitz `components/Blitz/`,
  Graph `components/Tasks/TaskView/TaskGraph.tsx`
- Task client `api/tasks.ts`, task-group hooks `hooks/useTaskGroups.ts`, live updates
  `hooks/useRadioEvents.ts`

## Gaps this plan fills

1. No user-settable stage — persisted status is only Active/Archived. → `board_column` +
   `board_order`.
2. No composite create+dispatch endpoint — UI chains create_task → create_chat → open
   chat WS. → `POST /dispatch`.
3. No auth on `grove web` (:3001); `--remote` adds none. → nanobot uses HMAC :3002.
4. No board web scaffold, no `TaskStageChanged` event. → `components/Board/` + new
   `RadioEvent` variant.

## Phased plan (with gates)

| Phase | What | Verify / gate |
|---|---|---|
| **0** | Pin a stable HMAC secret for `grove mobile` (:3002); store in 1Password | secret survives restart |
| **1** | Backend: `board_column` + `board_order` migration (`database.rs`), fields on `Task` + `TASK_COLUMNS` (`tasks.rs`), `PATCH /api/v1/.../tasks/{id}/stage`, `RadioEvent::TaskStageChanged` broadcast | `cargo build` + test |
| **2** | Backend: `POST /api/v1/projects/{id}/tasks/dispatch` = `create_task` + `create_chat` + auto-start; body `{title, body, agent:"claude"\|"codex", auto_start, into:"todo"\|"planned"}`; works on :3001 no-auth and :3002 HMAC | curl both ports |
| **3** ✅ | Web: `"board"` nav id + `components/Board/` — 4 columns (zinc/blue/amber/green accents), drag-to-PLANNED=dispatch, ongoing/done drag-locked, card anatomy per Dorothy + Grove diff stats, green-pulse/amber affordances, live via `useRadioEvents`. **Also added** backend `POST /tasks/{id}/start` (start agent on an *existing* card — dispatch only creates new tasks) + shared `start_agent_on_task` helper. | ✋ visual review |
| **4** | nanobot: rework `file_bug` — transcribe → classify → HMAC POST :3002 `/dispatch` (Grove lane) or Linear (Symphony lane); knob: drop into `todo` vs `planned` | dry-run |
| **5** | End-to-end smoke: voice bug → card → agent in worktree → PR | ✋ USER GATE |
| **6** *(opt)* | Grove-side skill-match auto-assign watcher (Dorothy `kanban-automation` analog) | later |

## Not doing (scope guards)

- Not rebuilding `mcp-kanban`/`mcp-orchestrator` — Grove's task model + Agent Graph +
  `/dispatch` already cover it.
- Not porting Dorothy's cream/teal theme — Grove dark skin only (a "Dorothy warm" Grove
  theme is a possible future add, deferred).
- Not adding priority / required-skills / progress-percent as first-class fields in v1
  (progress derives from `ChatStatus` todo counts; priority/skills are v1.1).
