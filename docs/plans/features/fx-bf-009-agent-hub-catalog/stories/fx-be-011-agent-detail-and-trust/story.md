---
id: FX-BE-011
title: Agent and skill detail, trust, and capabilities
status: complete
feature: FX-BF-009
issue: docs/issues/features/fx-bf-009-agent-hub-catalog/stories/fx-be-011-agent-detail-and-trust/issue.md
updated: 2026-08-31
tasks: [TASK-078, TASK-079]
dependencies: [FX-BE-010]
validation: [npm run check-types, focused Agent Hub Playwright tests]
---

# Agent and skill detail, trust, and capabilities

## Impact

Users must understand what an item can do and why an action is blocked before allowing it to run.

## Scope

- Detail panes for manifests and skills.
- Source path, transport, activation mode, capabilities, fingerprint, trust, and errors.
- Safe action states and advanced Settings boundary.

## Acceptance criteria

- Invalid and untrusted items cannot be started or activated.
- Capabilities and validation errors are visible without opening files manually.
- Everyday catalog actions are available in Agents; policy and diagnostics remain in Settings.

## Close when

Detail and trust states are understandable, keyboard accessible, and covered by focused UI tests.
