---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:41:43.988Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-015
title: Runtime lifecycle dashboard
status: complete
feature: FX-BF-011
issue: docs/issues/features/fx-bf-011-agent-runtime-session-integration/stories/fx-be-015-runtime-lifecycle-dashboard/issue.md
updated: 2026-08-31
tasks: [TASK-086, TASK-087]
dependencies: [FX-BE-011]
validation: [npm run test:core, npm run check-types, focused desktop tests]
---

# Runtime lifecycle dashboard

## Impact

Users can see and control trusted agent hosts from the same place where they discover them.

## Scope

- Runtime status contracts for discovered, running, stopped, failed, invalid, and approval-required states.
- Start, stop, restart through core, Electron main, preload, and renderer.
- Capabilities and runtime errors.

## Acceptance criteria

- Lifecycle actions are disabled for invalid or untrusted agents.
- Stop and restart dispose hosts safely and refresh visible state.
- Failure states remain inspectable and recoverable.

## Close when

Runtime state is accurate after refresh, lifecycle actions are safe, and no process is spawned by discovery alone.

## Description


## Dependencies



## Comments


