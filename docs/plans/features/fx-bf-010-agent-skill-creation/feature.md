---
**Status:** 📋 Proposed
**Created:** 2026-08-31T12:27:31.981Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-010
slug: agent-skill-creation
title: Agent and skill creation
status: proposed
owner: Electron desktop app
updated: 2026-08-31
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


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


