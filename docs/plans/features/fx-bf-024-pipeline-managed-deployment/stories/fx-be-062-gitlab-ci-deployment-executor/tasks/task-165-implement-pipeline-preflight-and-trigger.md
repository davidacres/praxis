---
type: Task
id: TASK-165
title: "Implement pipeline preflight and trigger"
status: planned
story: FX-BE-062
updated: 2026-09-07
dependencies: [FX-BE-061]
---

# TASK-165: Implement pipeline preflight and trigger

**Priority:** High
**Created:** 2026-09-07

## Goal

Resolve explicit GitLab project/ref and allowlisted inputs; verify capabilities and preserve provider errors without exposing credentials.

## Implementation entry points

packages/core/src/gitlab/gitLabApiService.ts; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-061
## Acceptance criteria

- Mock missing project, protected ref, permission failure and uncertain trigger response; tracker may be Jira or folder.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
