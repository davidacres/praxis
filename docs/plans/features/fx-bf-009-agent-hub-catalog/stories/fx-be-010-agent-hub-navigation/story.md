---
**Status:** 📋 Proposed
**Created:** 2026-08-31T20:04:21.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-010
title: Agent Hub navigation and scope-aware catalog
status: complete
feature: FX-BF-009
issue: docs/issues/features/fx-bf-009-agent-hub-catalog/stories/fx-be-010-agent-hub-navigation/issue.md
updated: 2026-08-31
tasks: [TASK-076, TASK-077]
dependencies: [FX-BF-005]
validation: [npm run check-types, npm run build:renderer, focused Agent Hub Playwright tests]
---

# Agent Hub navigation and scope-aware catalog

## Impact

Users need a trustworthy place to see what agents and skills are available instead of landing in the unrelated New Session composer.

## Scope

- Render `AgentsPage` for the Agents sidebar route.
- Show Global and Current project groups in a tree/detail layout.
- Refresh discovery and update the catalog when project scope changes.

## Acceptance criteria

- Selecting Agents opens the Agent Hub.
- Global items remain visible without an active project.
- Project-local items appear only in their project scope.
- Empty, loading, refresh, and discovery-error states are actionable.

## Close when

The route is visibly distinct from Sessions and the catalog correctly reflects both discovery scopes.

## Description


## Dependencies



## Comments


