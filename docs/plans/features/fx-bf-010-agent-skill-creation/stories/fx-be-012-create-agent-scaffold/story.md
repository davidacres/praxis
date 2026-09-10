---
**Status:** 📋 Proposed
**Created:** 2026-08-31T20:04:21.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-012
title: Create Agent wizard and starter scaffold
status: Done
feature: FX-BF-010
issue: docs/issues/features/fx-bf-010-agent-skill-creation/stories/fx-be-012-create-agent-scaffold/issue.md
updated: 2026-08-31
tasks: [TASK-080, TASK-081]
dependencies: [FX-BE-010]
validation: [npm run test:core, npm run check-types, focused desktop tests]
---

# Create Agent wizard and starter scaffold

## Impact

Users can define a new agent without hand-authoring an invalid manifest or guessing the runtime folder layout.

## Scope

- Scope, name, id, transport, command/URL, args, activation, and optional skills.
- Validated `agent.json` generation.
- Starter implementation files for the selected transport.

## Acceptance criteria

- The wizard rejects invalid ids, entries, duplicate ids, and unsafe paths.
- Output is discoverable after refresh in the selected scope.
- Generated starter files are clearly labeled as scaffolding.

## Close when

A new agent can be created, discovered, inspected, and safely left unstarted.

## Description


## Dependencies



## Comments


