---
**Status:** ✅ Complete
**Created:** 2026-08-31T12:27:31.981Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-009
slug: agent-hub-catalog
title: Agent Hub catalog and navigation
status: complete
owner: Electron desktop app
updated: 2026-08-31
issues: docs/issues/features/fx-bf-009-agent-hub-catalog/feature-issues.md
stories: [FX-BE-010, FX-BE-011]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---

# FX-BF-009: Agent Hub catalog and navigation

## Outcome

Make the Agents sidebar entry a real workspace-level catalog with global and project-local agent and skill visibility.

## Scope

- Tree/detail Agent Hub route with global and current-project groups.
- Agent and skill metadata, trust, validation, capability, and source presentation.
- Everyday catalog actions move out of Settings; advanced policy remains there.

## Story map

- `FX-BE-010` — Agent Hub navigation and scope-aware catalog.
- `FX-BE-011` — Agent and skill detail, trust, and capabilities.

## Dependencies

- `FX-BF-005` sidebar navigation.
- Existing agent runtime discovery and Electron IPC.

## Close when

Selecting Agents opens the catalog, scopes are clear, unsafe items are visibly blocked, and focused desktop tests pass.

## Description

## As built (2026-09-02)

- **Core (TASK-077):** `DiscoveredAgent` and `DiscoveredSkill` gained a `scope: 'global' | 'project'`
  field, tagged in `discoverAgents` / `discoverSkills` by which root the item came from (the
  user-data catalog vs a project `.praxis`). Project items are never auto-trusted. New
  `agentCatalog.ts` holds the pure view-model: `groupCatalog`, `agentStartBlockedReason`,
  `skillActivateBlockedReason`, `eligibleAgentsForSkill`, `describeCapabilities`,
  `agentHostStarted` — with `discovery.test.ts` + `agentCatalog.test.ts` (core now 296 tests).
- **Renderer:** `agents/AgentsPage.tsx` renders the `agents` route (was a "not wired up"
  placeholder). Two columns the feature owns (`showAux` excludes `agents`): a `.wf-rail`
  catalog grouped Global / *project name*, and a detail pane. `agents/agentCatalog.ts` mirrors
  the core helpers (renderer imports only types from `@praxis/core`).
- **Detail (TASK-078):** agent — id, transport, scope, activation, entry, config, declared
  skills, truncating source path, manifest errors, capability summary (or "host not started");
  skill — description, version, scope, trigger chips, fingerprint, source, error.
- **Fail-closed (TASK-079):** Start host / Activate are disabled with the blocking reason from
  the core helpers (invalid manifest, approval-required project agent, no eligible agent). The
  Settings `agent-runtime` section is now read-only diagnostics — Start/Activate moved to the
  hub; it keeps Refresh, the registry list (with scope), and paths.
- **Verification:** `agentHub.spec.ts` seeds a valid agent, an invalid agent, and a skill into
  the throwaway profile, drives the route, and asserts the fail-closed detail + a themed
  snapshot.

## As built — shell revision (2026-09-03)

The first cut built its own two-column catalog in the centre pane and suppressed
the shell's right pane, and it borrowed 21 of the Workflow designer's `wf-`
classes — which is why it read as out of place. Reworked to one idiom:

- **Navigation is the sidebar.** The `Agents` destination expands into its
  catalog, grouped Global / *project*, each row carrying the same trust and
  running vocabulary as the runtime panel. Create / Import / Rescan hang off a
  `+` menu on the row, replacing the four header buttons.
- **The centre is the record** — hero, chips (transport · scope · trust), then a
  definition-list of the manifest or skill package, in the ProjectHome rhythm.
  It answers "what is this?" and nothing else.
- **The right pane is the runtime** — host state with pid and uptime,
  capabilities, active skills with their negotiated mode, the sessions
  attributed to the agent, and every action that changes runtime state.
  `App.showAux` no longer excludes `agents`.
- App now owns the catalog snapshot (as it owns `workflowsByProject`), so the
  tree, the record, and the runtime panel all read one source and the right pane
  renders directly — no portal needed, unlike Workflows.
- Shared primitives moved out of the `wf-` prefix: `rail-*`, `inspector-*`,
  `inspector-actions`, `hint`, `lane*`, `issues`, `skeleton`, `form-field*`,
  `form-fieldset`, `form-check`. The Agents surface owns `agent-*`.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


