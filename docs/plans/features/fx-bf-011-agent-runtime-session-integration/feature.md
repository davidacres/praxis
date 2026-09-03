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
updated: 2026-08-31
issues: docs/issues/features/fx-bf-011-agent-runtime-session-integration/feature-issues.md
stories: [FX-BE-015, FX-BE-016, FX-BE-017]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# FX-BF-011: Agent runtime and session integration

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


