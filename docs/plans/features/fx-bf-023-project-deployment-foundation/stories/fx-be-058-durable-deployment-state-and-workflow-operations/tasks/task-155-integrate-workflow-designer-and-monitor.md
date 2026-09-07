---
type: Task
id: TASK-155
title: "Integrate workflow designer and monitor"
status: planned
story: FX-BE-058
updated: 2026-09-07
dependencies: [TASK-154]
---

# TASK-155: Integrate workflow designer and monitor

**Priority:** High
**Created:** 2026-09-07

## Goal

Add deployment node validation, inputs/outputs and dedicated status rendering while reusing gates; show deploy/verify separately and preserve existing workflow definitions.

## Implementation entry points

packages/core/src/workflows/workflowTypes.ts; workflowRun.ts; workflowRecovery.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-154
## Acceptance criteria

- Existing workflow fixtures remain unchanged; deployment cannot bypass configured approval or QA; node editor and monitor states have visual/accessibility verification.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
