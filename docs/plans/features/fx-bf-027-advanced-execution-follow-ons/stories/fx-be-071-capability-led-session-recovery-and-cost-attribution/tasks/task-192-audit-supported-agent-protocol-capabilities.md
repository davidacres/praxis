---
type: Task
id: TASK-192
title: "Audit supported agent protocol capabilities"
status: backlog
story: FX-BE-071
updated: 2026-09-07
dependencies: [FX-BF-024, FX-BF-026]
---

# TASK-192: Audit supported agent protocol capabilities

**Priority:** Low
**Created:** 2026-09-07

## Goal

Inspect installed stable ACP schema and current host handlers; map resume, commands, modes, questions and reconnect semantics with executable fixtures.

## Implementation entry points

packages/core/src/ai/acp; packages/core/src/ai/aiSessionManager.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BF-024
- FX-BF-026
## Acceptance criteria

- Document actual handled/unhandled capabilities and unstable fields; do not classify an unhandled stable event as unsupported by ACP.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
