# Fork status — ATECHPCS/grove

This is the **ATECHPCS** fork of [GarrickZ2/grove](https://github.com/GarrickZ2/grove).
It tracks upstream and adds a few local-only features, plus a set of changes
that are being contributed back as PRs. This file is the source of truth for
*how the branches relate* and *what's in flight* — keep it current as PRs land.

> Maintained by hand. When a PR merges/closes or a branch changes, update the
> tables below. Lives only on the fork (upstream never touches `FORK.md`), so it
> never causes a merge conflict on upstream sync.

_Last updated: 2026-06-02 (PR #18 superseded by #23; pr-blitz-grid retired, docs → docs/legacy/)_

## Branches

| Branch | Tracks | Role |
|---|---|---|
| `local/prod` | — (local) | **Deployment line** — what runs on this machine via systemd. Source of truth for fork work. Includes the fork-only dashboard (below). |
| `master` | `origin/master` ← upstream | Upstream mirror. Sync point; don't put fork code here. |
| `production` | `origin/production` | **Fork export** — `local/prod` minus the dashboard. One-way; never merge back. Regenerate from `local/prod` to refresh. |
| `pr/tmux-agent-terminal` | `origin/...` | Backs PR #19 |
| `pr/ios-pwa-fixes` | `origin/...` | Backs PR #20 |
| `pr/agent-graph-ally-reliability` | `origin/...` | Backs PR #21 |
| `pr/agent-named-sessions` | `origin/...` | Backs PR #22 |
| `pr/blitz-flexlayout` | `origin/...` | Backs PR #23 (flexlayout grid rewrite) |

> `pr-blitz-grid` (backed the closed PR #18) was deleted after #23 superseded it.
> Its local-only design/plan docs are preserved under [`docs/legacy/`](docs/legacy/).

## Open PRs → upstream (GarrickZ2/grove)

| PR | Status | Title |
|---|---|---|
| [#19](https://github.com/GarrickZ2/grove/pull/19) | 🟢 Open | tmux-backed agent terminal + per-chat launch picker |
| [#20](https://github.com/GarrickZ2/grove/pull/20) | 🟢 Open | Fix iOS standalone-PWA layout: safe-area, input zoom, full-screen fill |
| [#21](https://github.com/GarrickZ2/grove/pull/21) | 🟢 Open | Agent-graph: make orchestrator-spawned allies reliably reply |
| [#22](https://github.com/GarrickZ2/grove/pull/22) | 🟢 Open | feat(chat): name new sessions after their agent instead of a timestamp |
| [#23](https://github.com/GarrickZ2/grove/pull/23) | 🟢 Open | feat(blitz): grid workspace on flexlayout-react (supersedes #18) |
| [#18](https://github.com/GarrickZ2/grove/pull/18) | 🔴 Closed | feat(blitz): grid workspace — preset version, superseded by #23 |

Legend: 🟢 Open · 🟣 Merged · 🔴 Closed · ⚪ Draft

## Fork-only features (not upstreamed)

- **GrooveOffice / StatusBoard monitoring dashboard** — live Phaser pixel office
  + status board driven by Grove data. Lives on `local/prod` only and is
  **stripped** from the `production` export. Protected against accidental
  deletion by `.githooks/pre-commit` (guards `src/groove_dashboard.rs`,
  `grove-web/src/components/GrooveOffice`, `grove-web/src/components/StatusBoard`)
  and the `prod-snapshot-*` recovery tag.

## Conventions

- Keep fork-specific docs in their own files (like this one), not in `README.md`,
  to avoid conflicts when syncing `upstream/master`.
- Each upstream contribution gets its own `pr/<topic>` branch cut from
  `upstream/master`, build-verified, and PII-scanned before pushing.
