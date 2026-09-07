---
type: Task
id: TASK-138
title: "Define read-only CI evidence providers"
status: planned
story: FX-BE-053
updated: 2026-09-07
dependencies: [FX-BE-052]
---

# TASK-138: Define read-only CI evidence providers

**Priority:** High
**Created:** 2026-09-07

## Goal

Resolve explicit repository/project and pipeline connection independently of tracker; paginate runs/jobs and capture run attempt, head SHA, job URL, logs and available test artifacts.

## Implementation entry points

packages/core/src/github; packages/core/src/gitlab; renderer/src/workflows. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-052
## Acceptance criteria

- Mock pagination, missing permissions, expired artifacts and unavailable SHA; a Jira project can select GitHub CI and a folder project can select GitLab CI.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
