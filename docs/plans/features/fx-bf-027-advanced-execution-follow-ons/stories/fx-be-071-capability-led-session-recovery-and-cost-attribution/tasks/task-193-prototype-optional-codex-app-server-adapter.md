---
**Status:** 📋 Proposed
**Type:** Task
type: Task
id: TASK-193
title: "Prototype optional Codex App Server adapter"
status: backlog
story: FX-BE-071
updated: 2026-09-07
dependencies: [TASK-192]
---

# TASK-193: Prototype optional Codex App Server adapter

**Priority:** Low
**Created:** 2026-09-07

## Goal

Run a bounded local integration spike behind a capability boundary; compare history, approvals and interruption semantics to existing ACP and record go/no-go.

## Implementation entry points

packages/core/src/ai/acp; packages/core/src/ai/aiSessionManager.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-192
## Acceptance criteria

- No production dependency or replacement of ACP until version/support contract and regression fixtures justify it; prototype failure leaves existing hosts unchanged.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.

## Description


## Comments


