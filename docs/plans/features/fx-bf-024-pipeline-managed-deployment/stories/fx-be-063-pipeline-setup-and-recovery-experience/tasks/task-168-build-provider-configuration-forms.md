---
type: Task
id: TASK-168
title: "Build provider configuration forms"
status: planned
story: FX-BE-063
updated: 2026-09-07
dependencies: [FX-BE-062]
---

# TASK-168: Build provider configuration forms

**Priority:** High
**Created:** 2026-09-07

## Goal

Suggest Actions for a connected GitHub repository and GitLab CI for GitLab, but allow independent selection and manual repository bindings.

## Implementation entry points

renderer/src/deployments; packages/core/src/workflows. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-062
## Acceptance criteria

- Jira plus Actions and folder plus GitLab fixtures configure successfully; changing suggestion never silently changes saved execution mode.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
