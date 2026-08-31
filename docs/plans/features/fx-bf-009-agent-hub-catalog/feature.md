---
**Status:** 📋 Proposed
**Created:** 2026-08-31T12:27:31.981Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-009
slug: agent-hub-catalog
title: Agent Hub catalog and navigation
status: proposed
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


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


