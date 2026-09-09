---
type: Task
id: TASK-136
title: "Bound repair attempts and freshness"
status: complete
story: FX-BE-052
updated: 2026-09-09
dependencies: [TASK-135]
---

# TASK-136: Bound repair attempts and freshness

**Priority:** High
**Created:** 2026-09-07

## Goal

Use existing workflow stages with explicit attempt and elapsed-time budgets; freeze each changed snapshot and invalidate prior verification when that snapshot changes.

## Implementation entry points

packages/core/src/ai; packages/core/src/workflows; renderer/src/ai. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-135
## Acceptance criteria

- An unresolved reproduction stops with an actionable reason; stale green checks cannot pass a repaired snapshot; cancellation stops local child processes.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

- `packages/core/src/workflows/workflowRun.ts` enforces bounded retries with `canRetry()` and the per-node `maxAttempts` budget; failed work no longer reopens beyond the configured window.
- `packages/core/src/workflows/workflowRunSummary.ts` and `packages/core/src/workflows/workflowRunSummary.test.ts` surface the stage explanation, retry action, and captured `snapshotRef` so stale green checks are not mistaken for fresh verification.
- `packages/core/src/workflows/workflowOrchestrator.test.ts` proves cancellation stops child dispatches and queued runs do not continue after a cancellation path is taken.
- Verified with: `npm run compile --workspace=@praxis/core && node --test packages/core/out/workflows/workflowRun.test.js packages/core/out/workflows/workflowRunSummary.test.js packages/core/out/workflows/workflowOrchestrator.test.js`
