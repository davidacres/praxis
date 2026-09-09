---
type: Task
id: TASK-137
title: "Show diagnosis and verified outcomes"
status: complete
story: FX-BE-052
updated: 2026-09-09
dependencies: [TASK-136]
---

# TASK-137: Show diagnosis and verified outcomes

**Priority:** High
**Created:** 2026-09-07

## Goal

Display reproduction, hypothesis, patch and before/after test evidence, with a review handoff and continuation; keep unverified agent claims separate from check outcomes.

## Implementation entry points

packages/core/src/ai; packages/core/src/workflows; renderer/src/ai. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-136
## Acceptance criteria

- A seeded failing test is repaired by a scripted agent and independently rerun; failed verification stays failed; update user guide and relevant parity descriptions.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

- `packages/core/src/workflows/workflowRunSummary.ts` and `packages/core/src/workflows/workflowRunSummary.test.ts` expose stage explanations, gate state, session ids, artifacts, and the implementation snapshot ref in the run summary used by the diagnosis/verification flow.
- `packages/core/src/workflows/workflowStageTask.ts` and `packages/core/src/workflows/workflowStageTask.test.ts` keep the verification scope on the frozen implementation snapshot rather than the live branch, so the run narrative matches the evidence that actually passed.
- `packages/core/src/workflows/workflowGates.test.ts` verifies gate- and snapshot-driven state transitions, covering the distinction between a fresh repaired snapshot and a stale green result.
- Verified with: `npm run compile --workspace=@praxis/core && node --test packages/core/out/workflows/workflowRunSummary.test.js packages/core/out/workflows/workflowStageTask.test.js packages/core/out/workflows/workflowGates.test.js`
