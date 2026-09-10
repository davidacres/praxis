---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-142
title: "Resolve launch configuration"
status: in-progress
story: FX-BE-054
updated: 2026-09-07
dependencies: [TASK-141]
---

# TASK-142: Resolve launch configuration

**Priority:** High
**Created:** 2026-09-07

## Goal

Inspect project manifests and .NET launch settings to propose editable commands; persist only after review and distinguish bind addresses from browser origins.

## Implementation entry points

packages/core/src/projects; packages/core/src/host/ipcContracts.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-141
## Acceptance criteria

- Fixtures cover Node frontend, ASP.NET API and multiple services; no detected script or launch settings file is executed during discovery.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Status: discovery logic is implemented and tested; nothing yet walks a real project tree to find
manifests, and no UI presents/persists the proposal. Left `in-progress`.**

**Implemented:** `packages/core/src/projects/runProfileDiscovery.ts` (new):
- `proposeNodeRunService(packageJsonContent)` — reads a `package.json`'s own `scripts`, preferring
  `dev` > `start` > `serve` (a `dev` script wins over `start` when both exist, matching how a
  Vite/Next-style frontend is actually launched locally). Proposes `npm run <script>`, never
  evaluates the script string itself.
- `proposeDotnetRunService(launchSettingsContent)` — reads `Properties/launchSettings.json`,
  preferring the `commandName: "Project"` profile over an `IISExpress` one even when IIS Express is
  listed first. **Distinguishes bind address from browser origin explicitly**: `port` comes from the
  first URL in `applicationUrl`'s semicolon-separated list (the process's own bind address);
  `browserOrigin` is separate and only set when `launchBrowser` is true — either the bind URL itself,
  or, when `launchUrl` names a sub-path (e.g. `"swagger"`), that sub-path joined onto it. These are
  never conflated into one field.
- Both functions only ever call `JSON.parse` on the given string — there is no `child_process`
  import in this module, so "no detected script or launch settings file is executed during
  discovery" is true by construction, not by care taken at each call site. A malformed manifest (bad
  JSON, no matching script/profile) returns `undefined` rather than throwing.

**Commands run:** `npm run test:core` — 569/569 (13 new: a Vite-style and a start-only Node package,
dev-preferred-over-start, no-matching-script, malformed JSON, a dangerous-looking script string
proven never executed, an ASP.NET bind port distinct from a swagger browser origin, `launchBrowser:
false` producing no origin, Project-profile-preferred-over-IISExpress, and a combined
frontend+API "multiple services" scenario). `check-types` (root, all three workspaces) — clean.

**Remaining limitations:** No file-tree walk exists yet to actually *find* `package.json` /
`Properties/launchSettings.json` under a project folder — these functions take already-read content
and are called by a caller kept out of core. No IPC exposes discovery to the renderer, and nothing
persists a proposal into a `run.praxis.json` (TASK-141's `validateRunProfile`/`serializeRunProfile`
exist for that, unwired). "Persist only after review" has no reviewing surface yet — that is
TASK-143's editor.

## Description


## Comments


