---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-179
title: "Document supported methods and recovery"
status: planned
story: FX-BE-066
updated: 2026-09-07
dependencies: [TASK-178]
---

# TASK-179: Document supported methods and recovery

**Priority:** High
**Created:** 2026-09-07

## Goal

Explain required tooling, permission setup, config/data exclusions, health checks, downtime and manual recovery; show Local and Production profile examples.

## Implementation entry points

docs/user-guide.md; deployment integration fixtures. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-178
## Acceptance criteria

- A reviewer can follow the guide against the disposable fixture; every advertised method has evidence and unsupported remote transport is named.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


