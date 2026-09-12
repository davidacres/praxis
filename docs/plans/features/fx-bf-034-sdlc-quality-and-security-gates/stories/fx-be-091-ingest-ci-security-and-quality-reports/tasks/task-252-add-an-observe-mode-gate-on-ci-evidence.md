---
**Status:** ✅ Complete
**Type:** Task
type: Task
id: TASK-252
title: "Add an observe-mode gate resting on imported CI evidence"
status: Done
story: FX-BE-091
updated: 2026-09-09
dependencies: [TASK-251, TASK-239]
---

# TASK-252: Add an observe-mode gate resting on imported CI evidence

**Priority:** Medium
**Created:** 2026-09-09

## Goal

Let a `security` or `qa` gate be marked observe-mode: instead of running a local check, it resolves from imported CI `findings` for the run's snapshot SHA, evaluated against the same TASK-239 threshold. If the SHA matches and the report is present, the gate passes/fails from it; if the report is not yet available, the gate is `pending` (reconciling), not passed; if the SHA does not match, it falls back to the local check rather than trusting stale evidence. The imported run provenance is on the run event log.

## Implementation entry points

packages/core/src/workflows/workflowTypes.ts (an `observe` flag / source on a gate-owning node), workflowGates.ts (observe resolution: match SHA → evaluate imported findings → else fallback/pending), workflowRun.ts (event-log the provenance), renderer run monitor (show "from CI run …" on the gate row).

## Dependencies

- TASK-251
- TASK-239
## Acceptance criteria

- With imported evidence for the matching SHA, an observe-mode `security` gate passes/fails from it and no local scanner runs; the gate row shows the CI run reference.
- Report not yet available → gate `pending` with a reconciling reason, never an implicit pass.
- Snapshot SHA mismatch → the local check runs as the fallback.
- Observe mode is opt-in per gate; a gate without the flag is unchanged.
- The implementation satisfies the parent story's outcome and preserves existing unrelated gate evaluation.

## Verification

Core tests for the four resolution paths (match+present, match+absent, mismatch, flag-off). Electron spec for the gate row showing the CI reference with inspected captures. `npm run test:core`, `npm run test:desktop:workflows`, `npm run check-types`. Prove the "absent report cannot pass" and "mismatch falls back" guards fail against a naive trust-any-evidence check. Update feature-parity CI-evidence rows. Never point a Praxis write path at the repository's own plans.

## Description


## Comments

### Completion Notes (TASK-252)
- Added `observe` configuration property on `WorkflowCheckNode` (`{ enabled: boolean; provider?: string }`) in `packages/core/src/workflows/workflowTypes.ts`.
- Implemented observe-mode gate resolution in `evaluateGates` (`packages/core/src/workflows/workflowGates.ts`):
  1. Matches commit SHA between run snapshot and imported CI report: if valid and present, resolves against gate thresholds with active waivers applied.
  2. If report is not yet available, keeps gate in `pending` status with detail `...is observing CI for <sha>: report reconciling/not yet available.`
  3. If commit SHA differs (stale CI report), falls back cleanly to executing the local check command.
  4. If `observe.enabled` is false/unset, evaluates local check as usual.
- Recorded CI run provenance in gate detail string (`Observed from CI (provider run <id>@<sha>)`).
- Verified across all four resolution paths in `packages/core/src/ci/ciSecurityReports.test.ts`.


