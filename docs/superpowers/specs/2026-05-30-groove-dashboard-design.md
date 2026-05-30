# Groove Dashboard — Design

**Date:** 2026-05-30
**Branch:** `groove-dashboard`
**Scope:** Add a dedicated read-only LAN TV dashboard for Grove, showing an office-style animated overview of all Grove projects, coding agents, agent/session uptime, and token/activity statistics.

## Problem

Grove has strong project, task, Blitz, and statistics surfaces for interactive work, but no passive "wall display" that someone can leave on a TV and glance at from across the room. The user wants a Groove Zen dashboard similar in spirit to the Nanobot Mission Control office display, redesigned for Grove agents such as Claude, Codex, and Gemini.

The display must be reachable from another device on the same LAN by binding the Grove web app to the dev machine's LAN interface. It should be public read-only on the LAN, so it must not expose filesystem paths, prompts, terminal output, secrets, or editing controls.

## Goals

- Serve a dedicated TV route at `/groove-dashboard`.
- Run as part of the Grove web app on the dev device, not in Docker.
- Support binding Grove web to `0.0.0.0` or the dev device LAN IP so another LAN device can open `http://<dev-device-lan-ip>:<grove-port>/groove-dashboard`.
- Show all Grove projects in a zoomed-out office floor plan.
- Use friendly project names only; hide full project paths.
- Show real Grove data whenever available: projects, agents, active sessions, token totals, recent activity, and agent/session uptime.
- Add clearly ambient local animation for quiet projects/agents so the TV view stays lively without inventing fake real work.
- Keep the TV route read-only and public-safe.
- Minimize load on the Grove service with a single compact cached aggregate endpoint.

## Non-goals

- Docker deployment for v1.
- Editing projects, tasks, branches, settings, or sessions from the TV dashboard.
- Showing raw prompts, terminal logs, full paths, secrets, or other sensitive operational data.
- Pixel-perfect recreation of the Nanobot Mission Control dashboard.
- Per-user customization of the floor plan in v1.

## Decisions

1. **Dedicated route:** Use `/groove-dashboard`, outside the normal Grove shell/sidebar.
2. **LAN exposure model:** The route is public read-only on the LAN. Normal Grove app auth/access behavior remains unchanged.
3. **Runtime location:** Run on the dev device with Grove web bound to `0.0.0.0` or the device LAN IP. Do not require Docker.
4. **Data scope:** Show all Grove projects, not only active projects.
5. **Project labels:** Show friendly project names only; never show full paths on the public TV route.
6. **Layout direction:** Use an Office Floor layout: project rooms/desks, animated agent fellows, and a stats rail.
7. **Overflow strategy:** Fit all project rooms in a zoomed-out floor plan rather than rotating rooms or hiding quiet projects.
8. **Agent design:** Use custom office bodies with official-style agent icons or badges as the agent identity treatment.
9. **Uptime definition:** Uptime means agent/session uptime, not just Grove server uptime.
10. **Data policy:** Real data wins. Ambient animation is local visual behavior and must not pretend to be real token counts, tasks, or agent actions.

## Architecture

Add a dedicated public route at `/groove-dashboard`. The route renders outside the authenticated Grove app shell and contains no sidebar, command palette, project controls, or editing workflows.

The frontend calls one read-only aggregate endpoint, likely `GET /api/v1/groove-dashboard`, on a low-frequency polling interval. The endpoint returns only display-safe fields:

- friendly project names and project IDs
- agent names/types and public icon identifiers
- active/idle/error state
- agent/session uptime seconds
- token totals and current-period counts
- total project count and active session count
- compact recent activity summaries safe for public display

The backend should cache this aggregate payload for a short interval, around 5 seconds, to avoid repeated database/session aggregation when the TV refreshes or multiple devices view the route. The frontend can poll every 10 seconds by default.

## Components

### `GrooveDashboardPage`

Full-screen page for `/groove-dashboard`. Owns polling, snapshot state, stale-data handling, and reduced-motion detection. It should keep the last successful snapshot on screen if the API temporarily fails.

### `OfficeFloor`

Responsive zoomed-out floor plan that fits all projects in the viewport. It lays out one room per Grove project and scales room density based on project count. It should prioritize TV readability: stable dimensions, no layout shift, and no tiny critical text beyond friendly project names.

### `ProjectRoom`

Displays one Grove project room with:

- friendly project name
- active/idle/error visual state
- visible agent fellows assigned to or active in that project
- small status treatment for quiet rooms

### `AgentFellow`

Animated character for an agent. The body is custom and office-themed; the identity is shown via official-style icon head/badge for Claude, Codex, Gemini, and other Grove agents. States:

- active: focused desk/work animation
- idle: subtle ambient movement
- error: visible but non-alarming warning state
- offline/unknown: muted stationary state

`prefers-reduced-motion` should disable or greatly reduce wandering/bobbing animations.

### `StatsRail`

TV-readable metrics:

- total tokens
- active sessions
- total projects
- agent/session uptime
- current live/stale status

### `ActivityTicker`

Compact recent activity strip. It may show real public-safe activity summaries when available. During quiet periods it may show ambient office status lines, but those lines must be visually/textually distinct from real events and must not imply fake task progress or fake token usage.

## Data Flow

```text
TV browser:
  GET /groove-dashboard
    -> renders standalone TV page
    -> polls GET /api/v1/groove-dashboard every ~10s

Backend aggregate endpoint:
  read Grove project list
  read active/known agent session state
  read token usage/statistics summaries
  derive friendly names and public activity summaries
  remove sensitive fields
  cache compact payload for ~5s
  return public dashboard snapshot

Frontend:
  render last successful snapshot
  overlay local ambient animation for quiet rooms
  replace ambient state immediately when real activity appears
```

## Public Safety

The TV endpoint and aggregate API must not return:

- filesystem paths
- raw prompts or chat transcript content
- terminal output
- environment variables
- secrets or credentials
- branch names, branch status, commit details, and other git internals
- mutation endpoints or action tokens

Friendly project names should be derived from existing Grove project names or sanitized basenames. The response should be shaped specifically for public display rather than reusing broad project/task/session API responses.

## Failure States

| State | Behavior |
|---|---|
| API unavailable | Keep the last good snapshot on screen and show a subtle disconnected/stale indicator. |
| No projects | Show an empty office with a simple "No Grove projects yet" state. |
| No active sessions | Show all project rooms, idle agents where known, total project count, and ambient movement. |
| Missing token data | Show token metric as unavailable/zero according to existing statistics semantics; do not fabricate counts. |
| Reduced motion | Pause wandering/bobbing and use static state indicators. |
| Too many projects | Fit all rooms in a zoomed-out floor plan; keep friendly names legible as much as possible. |

## Dev-Device LAN Binding

The intended v1 deployment is the developer machine running Grove web. The app must be launchable so another LAN device can open the dashboard:

```bash
grove web --host 0.0.0.0
```

or an equivalent Grove-supported bind option. The route should then be reachable at:

```text
http://<dev-device-lan-ip>:<grove-port>/groove-dashboard
```

If Grove's current web launch path does not expose a host/bind option, implementation should add or document the smallest compatible path for binding the web server to `0.0.0.0` while keeping existing localhost behavior as the default.

## Testing

### Backend

- Aggregate endpoint returns only public dashboard fields.
- Friendly project names are used instead of filesystem paths.
- Sensitive fields are not present in serialized JSON.
- Cache behavior prevents repeated heavy aggregation inside the cache window.
- Missing project/session/statistics data produces stable empty payloads.

### Frontend

- `/groove-dashboard` renders outside the normal Grove shell.
- Office Floor renders projects, agents, and stats from a sample payload.
- Full project paths are not displayed.
- Stale/API failure state keeps the last successful snapshot visible.
- Reduced-motion mode disables or reduces active animation behavior where practical.

### Manual

1. Start Grove web bound to `0.0.0.0` or the dev device LAN IP.
2. Open `http://<dev-device-lan-ip>:<grove-port>/groove-dashboard` from another LAN device.
3. Confirm it fits a TV-sized viewport.
4. Confirm all Grove projects appear with friendly names only.
5. Confirm token totals, active sessions, and agent/session uptime update from real data.
6. Confirm inactive projects get ambient office motion without fake metrics or fake task progress.

## Estimated File Changes

| Area | Expected change |
|---|---|
| Backend API | New public read-only dashboard aggregate endpoint and route registration. |
| Backend aggregation | New service/helper for compact public Groove Dashboard snapshot and short cache. |
| Grove web routing | Dedicated `/groove-dashboard` render path outside normal shell. |
| Frontend API client | New `getGrooveDashboardSnapshot()` client and response types. |
| Frontend components | New `GrooveDashboard` component group: page, office floor, room, agent fellow, stats rail, ticker. |
| Styling | TV-specific office floor styles with responsive scaling and reduced-motion handling. |
| Tests | Focused frontend/backend tests for route, public payload safety, rendering, and cache behavior. |
