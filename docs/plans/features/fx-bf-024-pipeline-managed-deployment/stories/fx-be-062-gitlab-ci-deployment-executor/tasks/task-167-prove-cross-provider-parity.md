---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-167
title: "Prove cross-provider parity"
status: planned
story: FX-BE-062
updated: 2026-09-07
dependencies: [TASK-166]
---

# TASK-167: Prove cross-provider parity

**Priority:** High
**Created:** 2026-09-07

## Goal

Run shared executor contract scenarios for GitHub and GitLab with a common renderer and capabilities for unavailable operations.

## Implementation entry points

packages/core/src/gitlab/gitLabApiService.ts; packages/core/src/deployments (new). Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-166
## Acceptance criteria

- Both providers preserve exact source/artifact identity and distinguish pipeline success from app health; document supported scopes and limitations.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


