# Fork status — ATECHPCS/grove

This is the **ATECHPCS** fork of [GarrickZ2/grove](https://github.com/GarrickZ2/grove).
It tracks upstream and adds a substantial set of local-only features (a
remotely-driven, multi-agent ops layer), plus changes contributed back as PRs.
This file is the source of truth for *how the branches relate*, *what runs in
production*, and *what's in flight* — keep it current as PRs land.

> Maintained by hand. When a PR merges/closes or a branch changes, update the
> tables below. Lives only on the fork (upstream never touches `FORK.md`), so it
> never causes a merge conflict on upstream sync.

_Last updated: 2026-09-01 (unified deploy line; added Board + nanobot bridge + task auto-start + chat-load perf inventory)._

## Production snapshot

- **Runs on:** MintBoxDev (`10.10.0.177`), user `dev`, via systemd `--user`
  units (`grove-mobile-3002`, `grove-web-3001`, `grove-socat`).
- **Deployed commit:** `local/prod` == `deploy/phase0` (kept equal — see below).
- **Version string:** `0.12.8` (fork versioning; upstream tops out at `v0.12.2`).
- **Distance from vanilla:** ~144 commits / ~16k insertions ahead of upstream
  `v0.12.2`; we are missing only 1 trivial upstream commit.

Diff against vanilla:
`git diff $(git merge-base local/prod upstream/master)..local/prod`

## Branches

| Branch | Tracks | Role |
|---|---|---|
| `deploy/phase0` | `origin/deploy/phase0` | **Canonical deploy branch.** The binary built + installed on `.177` (`grove` + `grove-phase0`, byte-identical) comes from here. Mobile binary is named `grove-phase0`. |
| `local/prod` | — (local) | **Integration line / source of truth for fork work.** Kept **equal to** `deploy/phase0`: after any fix, `git push origin local/prod:deploy/phase0`. If they drift, a rebuild from the stale deploy branch silently regresses features (this bit us 2026-08-31). |
| `master` | `origin/master` ← upstream | Upstream mirror. Sync point; don't put fork code here. |
| `production` | `origin/production` | Older fork export (0.11.7-era, `local/prod` minus the dashboard). Superseded by `deploy/phase0`; not the live line. |
| `feat/board-nanobot` | `origin/...` | Merged into `local/prod` 2026-08-31 (Board + nanobot bridge). |
| `feat/task-auto-start` | `origin/...` | Ported onto `local/prod` 2026-09-01 (backs PR #27). Nothing stranded now. |
| `pr/tmux-agent-terminal` | `origin/...` | Backs PR #19 |
| `pr/ios-pwa-fixes` | `origin/...` | Backs PR #20 |
| `pr/agent-graph-ally-reliability` | `origin/...` | Backs PR #21 |
| `pr/agent-named-sessions` | `origin/...` | Backs PR #22 |
| `pr/blitz-flexlayout` | `origin/...` | Backs PR #23 (flexlayout grid rewrite) |
| `pr/companion-picker-fallback` | `origin/...` | Backs PR #28 |
| `pr/companion-assets-guard` | `origin/...` | Backs PR #29 |

> **Deploy recipe:** `cargo build --release --bin grove` → `install -m755
> target/release/grove ~/.local/bin/grove` **and** `…/grove-phase0` →
> `systemctl --user restart grove-mobile-3002 grove-web-3001` (needs
> `XDG_RUNTIME_DIR` + `DBUS_SESSION_BUS_ADDRESS` exported). Healthy probe =
> `401`/JSON on `https://10.10.0.177:3002/api/v1/capabilities`, never
> `<!doctype html>`.

## What production runs vs vanilla

Vanilla Grove is a single-user local IDE. This fork turns it into a
**remotely-driven, multi-agent ops platform**. Grouped by theme:

### Major features (absent from vanilla)

1. **Kanban Board + Global Board** — native board mode, `board_column` /
   `board_order` stages, `PATCH /stage`, `TaskStageChanged` events, card-click
   opens the task, per-project task defaults/routing
   (`GET/PUT /projects/{id}/settings`).
2. **Task auto-start** — "⚡ Start agent on these notes" checkbox in the New
   Task dialog delivers the description as the chat's first prompt at creation;
   plus `POST /tasks/dispatch` (create task + auto-spawn agent in one call).
3. **Nanobot ⇄ Grove bridge** (how the `file_bug` / dispatch pipeline works):
   - `GET /api/v1/capabilities` — routing preflight.
   - HMAC **A2 body-binding** auth on sensitive routes: body-integrity check +
     sender allowlist + audit log, query-fallback bypass closed, nonce/timing
     hardening.
   - `GROVE_MOBILE_PASSKEY` env — stable HMAC secret across restarts.
   - `origin_ref` dedup; `--remote` flag for no-auth-behind-proxy deployments.
4. **GrooveOffice / StatusBoard dashboard** — live Phaser pixel office +
   privacy-safe status board at `/groove-dashboard`, brand-coloured workers
   reflecting real agent activity via token recency. Protected against
   accidental deletion by `.githooks/pre-commit`.
5. **Blitz grid on FlexLayout** — drag-a-task-onto-grid session picker,
   per-panel project·task·chat breadcrumbs, column presets (1/2/3),
   collapsible sidebar.

### Enhancements over vanilla behavior

- **Per-agent chat defaults** — Settings UI + seeding on session-ready +
  `/config` serialization (vanilla has one global default).
- **Terminal-mode agents** — per-chat ACP-vs-terminal picker; tmux-backed
  sessions survive disconnects; launch-mode routing/registry fixes.
- **Agent-graph reliability** — idle-aware reply-timeout watchdog, auto-approve
  graph-spawned allies, forceful client-agnostic reply instructions.
- **Chat-load perf (Defect B)** — incremental render (rebuild only the
  streaming turn), bounded load derivations, warm-cache switch-back fix,
  fan-out cap, final-reply-visible fix.
- **PWA / iOS + resilience** — safe-area insets, zoom/gap fixes, WS reconnect
  on wake/online, heartbeat ping to survive proxy idle-reaping, SW
  cache-control.
- **Per-agent capability cache** — store + `GET /agents/{id}/capabilities`.
- **Chat sessions named after their agent** instead of a timestamp.

## Open PRs → upstream (GarrickZ2/grove)

> Statuses below were last hand-checked 2026-08-12; re-verify with
> `gh pr list --repo GarrickZ2/grove` before relying on them.

| PR | Status | Title |
|---|---|---|
| [#29](https://github.com/GarrickZ2/grove/pull/29) | 🟢 Open | fix(extension): require manifest.json before reporting the companion installed |
| [#28](https://github.com/GarrickZ2/grove/pull/28) | 🟢 Open | fix(extension): fall back to the web picker when the companion installer's native dialog cannot open |
| [#27](https://github.com/GarrickZ2/grove/pull/27) | 🟢 Open | feat(tasks): opt-in agent auto-start from the New Task description |
| [#25](https://github.com/GarrickZ2/grove/pull/25) | 🟢 Open | fix(acp): honor chat launch mode when selecting agent channel |
| [#23](https://github.com/GarrickZ2/grove/pull/23) | 🟢 Open | feat(blitz): grid workspace on flexlayout-react (supersedes #18) |
| [#22](https://github.com/GarrickZ2/grove/pull/22) | 🟢 Open | feat(chat): name new sessions after their agent instead of a timestamp |
| [#19](https://github.com/GarrickZ2/grove/pull/19) | 🟢 Open | tmux-backed agent terminal + per-chat launch picker |
| [#26](https://github.com/GarrickZ2/grove/pull/26) | 🟣 Merged | fix(projects): fall back to web picker on headless Linux |
| [#21](https://github.com/GarrickZ2/grove/pull/21) | 🟣 Merged | Agent-graph: make orchestrator-spawned allies reliably reply |
| [#20](https://github.com/GarrickZ2/grove/pull/20) | 🟣 Merged | Fix iOS standalone-PWA layout: safe-area, input zoom, full-screen fill |
| [#18](https://github.com/GarrickZ2/grove/pull/18) | 🔴 Closed | feat(blitz): grid workspace, preset version, superseded by #23 |

Legend: 🟢 Open · 🟣 Merged · 🔴 Closed · ⚪ Draft

## Conventions

- Keep fork-specific docs in their own files (like this one), not in
  `README.md`, to avoid conflicts when syncing `upstream/master`.
- Each upstream contribution gets its own `pr/<topic>` branch cut from
  `upstream/master`, build-verified, and PII-scanned before pushing.
- **Never let `deploy/phase0` and `local/prod` drift** — the deploy branch is
  what gets built; a stale one regresses whatever is only on `local/prod`.
