---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-166
title: "Observe pipelines and environments"
status: To Do
story: FX-BE-062
updated: 2026-09-07
dependencies: [TASK-165]
---

# TASK-166: Observe pipelines and environments

**Priority:** High
**Created:** 2026-09-07

## Goal

Map pipeline/job/deployment identity and environment URLs; support observation of existing CD and pagination/retry.

## Implementation entry points

packages/core/src/gitlab/gitLabApiService.ts; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-165
## Acceptance criteria

- Existing pipeline is attached without another trigger; repeated events and reconnect produce one durable deployment record.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


