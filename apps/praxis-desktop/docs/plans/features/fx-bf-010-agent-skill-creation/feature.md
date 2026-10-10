---
**Status:** ✅ Complete
**Created:** 2026-08-31T12:27:31.981Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-010
slug: agent-skill-creation
title: Agent and skill creation
status: Done
owner: Electron desktop app
updated: 2026-10-10
issues: docs/issues/features/fx-bf-010-agent-skill-creation/feature-issues.md
stories: [FX-BE-012, FX-BE-013, FX-BE-014]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# FX-BF-010: Agent and skill creation

## Outcome

Let users create, scaffold, import, and validate agents and complete skill packages in the selected global or project scope.

## Scope

- Create Agent wizard producing `agent.json` and transport starter files.
- Create Skill wizard producing a complete validated package.
- Import, duplicate detection, safe paths, and fail-closed validation.

## Story map

- `FX-BE-012` — Create Agent wizard and starter scaffold.
- `FX-BE-013` — Create complete Skill package.
- `FX-BE-014` — Import and validate runtime items.

## Dependencies

- `FX-BF-009` Agent Hub catalog.
- Existing manifest and skill registry contracts.

## Close when

Generated and imported items are safe, discoverable, correctly scoped, and covered by core and desktop tests.

## Description

## As built (2026-09-02)

- **Core `agentAuthoring.ts`:** pure, fail-closed builders — `planNewAgent` /
  `planNewSkill` return a folder name + file list (empty on any error),
  `buildAgentManifest` runs core's real `validateAgentManifest`, `buildSkillDoc`
  emits closable front matter. Import: `validateAgentImport` / `validateSkillImport`
  → an `ImportPreview` (name, `duplicate`, `errors`), `resolveImportFolder` derives
  `-2`, `-3`… for a rename. `safeSegment` (dash-case, 2–64 chars) and `safeJoin`
  (throws on traversal / absolute) gate every path. `agentAuthoring.test.ts` — core
  is now 306 tests.
- **IPC:** `AgentRuntimeIpc` gains `createAgent`, `createSkill`, `previewImport`,
  `importItem`. The main-process `agentRuntimeAuthoring.ts` resolves the scope root
  (`userData/agents` vs `<workingDir>/.praxis/agents`, and the skills equivalents),
  re-runs the core planner with the authoritative existing names, and writes with
  `flag: 'wx'` (never overwrites). Import does a `.`-skipping recursive `copyTree`
  through `safeJoin`; nothing is executed.
- **Renderer:** `AgentHubDialogs.tsx` — `CreateAgentDialog`, `CreateSkillDialog`,
  `ImportDialog`, opened from `+ Agent` / `+ Skill` / `Import` in the hub header.
  `agentAuthoring.ts` (renderer) does light inline validation; the server is
  authoritative. Import uses the existing `dialog.pickFolder`, then shows the
  preview verdict (valid / errors / duplicate → cancel or rename) before writing.
- **Verification:** `agentHub.spec.ts` — the Create wizard writes a validated
  `agent.json` + scaffold and it appears in the catalog; import validates a folder
  without running it and rejects a bad manifest; snapshots for the hub header and
  the create dialog.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments

**2026-10-10:** Status rollup corrected during backlog review: all child stories and tasks are Complete and the feature's 'Close when' criteria are met by the shipped work (see 'As built'), so the feature is Done.
