---
type: Task
id: TASK-172
title: "Validate target boundaries and credentials"
status: planned
story: FX-BE-064
updated: 2026-09-07
dependencies: [TASK-171]
---

# TASK-172: Validate target boundaries and credentials

**Priority:** High
**Created:** 2026-09-07

## Goal

Reject ambiguous site selection and path escape; resolve least-required credential references on the executor; keep machine bindings out of portable exports.

## Implementation entry points

packages/core/src/deployments; main/src/main; renderer/src/deployments. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-171
## Acceptance criteria

- Missing rights, locked paths and mismatched site/application block preparation with actionable diagnostics; secrets are redacted from evidence.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

Record implemented paths, commands, results, actual capture review (if UI), and remaining limitations here when completing the task. Planned acceptance is not evidence of completed implementation.
