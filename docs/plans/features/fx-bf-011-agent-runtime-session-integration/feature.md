---
**Status:** ✅ Complete
**Created:** 2026-08-31T12:27:31.982Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-011
slug: agent-runtime-session-integration
title: Agent runtime and session integration
status: complete
owner: Electron desktop app
updated: 2026-09-03
issues: docs/issues/features/fx-bf-011-agent-runtime-session-integration/feature-issues.md
stories: [FX-BE-015, FX-BE-016, FX-BE-017]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# FX-BF-011: Agent runtime and session integration

> The Sessions surface this feature reshaped kept growing after it closed —
> review, cost/context/task visibility, and correction controls are
> `FX-BF-015`. This feature's own scope (runtime lifecycle, skill handoff,
> the Settings boundary) is unchanged and complete as recorded below.

## Outcome

Make the Agent Hub operational with runtime health, lifecycle controls, skill activation, and direct handoff into Sessions.

## Scope

- Runtime status and safe start, stop, and restart controls.
- Agent/skill context carried into new sessions.
- Advanced runtime settings, accessibility, error-state, and visual verification.

## Story map

- `FX-BE-015` — Runtime lifecycle dashboard.
- `FX-BE-016` — Skill activation and session handoff.
- `FX-BE-017` — Advanced Settings boundary and verification.

## Dependencies

- `FX-BF-009` Agent Hub catalog.
- `FX-BF-010` Agent and skill creation.

## Close when

Users can operate trusted hosts, activate skills, open linked sessions, and diagnose runtime problems from the correct surfaces.

## As built — shell revision (2026-09-03)

The Sessions surface had the same shape the Agent Hub and the Git graph had
before their revisions: it built its own navigation in the centre pane while the
shell's right pane showed something unrelated.

- **The dead right pane.** `onSelectFeature` navigates to a bare `{ feature }`,
  so on `sessions` (and `epics`, `issues`, `connections`) the aux chain fell all
  the way through to the `aux-empty` state — "Select a work item to see its
  details.", which nothing on those routes can ever populate.
- **The duplicated furniture.** The session list was a 300px column the feature
  owned, with its own dock-left/dock-right preference, its own collapse-to-rail,
  and CSS whose comment said it was "styled to match the app's own Sidebar
  (`.pane-sidebar`)". The shell already provides all of that.

Reworked to the one idiom:

- **Navigation is the sidebar.** The `Sessions` destination expands into its
  sessions, newest first, with rename and delete on the row and `+` for a new
  session. State is a lane dot with the label as its tooltip — the Agents tree's
  vocabulary; a full text badge does not fit a tree row.
- **The centre is the conversation** — the console at full width, keeping only
  the session's name and the two view toggles (plain background, browser).
- **The right pane is the session** — live state, mode, started/steps, then the
  facts fixed when it started (provider, model, tool access, folder, worktree),
  then every action that changes it: mode switching and worktree removal (which
  carry their own transition prompt and confirm dialog, so they moved whole),
  and Abort. `SessionInspector` mirrors `AgentRuntimePanel`.
- Naming and classification helpers moved to `ai/sessionNav.ts`, shared by the
  three surfaces instead of duplicated.
- Removed: `.sessions-list`, `.sessions-list-rail`, `.session-item*`, the
  `side-left`/`side-right`/`list-collapsed` modifiers and the two localStorage
  layout preferences behind them. No test covered the dock preference.

## Description

## As built (2026-09-03)

- **FX-BE-015 — Lifecycle.** `AgentRuntimeSnapshot.hosts` carries per-agent
  `HostRuntimeStatus` (running / failed, startedAt, pid, error); the manager
  records it on `start` and adds `stop` / `restart`. Discovery never populates
  it. `agentRuntime.stop` / `.restart` over IPC; the hub detail shows a Host row
  and Start ⇄ Restart + Stop, a running dot on rows, and "N running" in the
  header. `manager.test.ts` covers it with a real subprocess.
- **FX-BE-016 — Activation & handoff.** The hub captures the `ActivatedSkill`
  mode and shows "Active skills: name (mode)" on the agent and "Active on
  <agent> · <mode> mode" on the skill. "Open a session" navigates to the New
  Session composer with `route.newSessionAgent` / `newSessionSkills`; the
  composer shows an attribution note and passes `agentId` / `skillNames` into
  `ai.delegate`, which already activates the skills and injects their
  instructions. `AgentSessionRecord` gains `agentId` / `activeSkills`
  (persisted via `updateAgentRuntime`); the agent detail lists its sessions and
  links to them.
- **FX-BE-017 — Settings boundary.** The Settings `agent-runtime` section is
  read-only diagnostics: registry list, running count, `Refresh`, and (new)
  the discovery paths from `agentRuntime.roots()`. Everyday start / stop /
  activate live only in the hub. `agentHub.spec.ts` covers catalog, lifecycle,
  activation + handoff, creation, and import; landmarks + `aria-pressed` rows +
  disabled-with-reason buttons carry the accessibility surface.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


