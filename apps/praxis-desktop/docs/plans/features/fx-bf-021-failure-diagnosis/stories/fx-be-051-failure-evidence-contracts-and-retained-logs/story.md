---
**Status:** In Progress
**Type:** Story
type: Story
id: FX-BE-051
title: "Failure evidence contracts and retained logs"
status: Done
feature: FX-BF-021
updated: 2026-09-25
dependencies: [FX-BE-024, FX-BE-025, FX-BE-041]
---

# FX-BE-051: Failure evidence contracts and retained logs

**Priority:** High
**Created:** 2026-09-07

## Outcome

Model versioned evidence bundles keyed by project, run, node, attempt and source commit; retain logs even when commands time out or fail to start.

## Scope and implementation entry points

packages/core/src/workflows; main/src/main/workflowCheckRunner.ts. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-024
- FX-BE-025
- FX-BE-041
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-132](tasks/task-132-define-evidence-identity-and-storage.md) | Define evidence identity and storage |
| 2 | [TASK-133](tasks/task-133-preserve-failed-process-evidence.md) | Preserve failed process evidence |
| 3 | [TASK-134](tasks/task-134-expose-evidence-in-the-run-monitor.md) | Expose evidence in the run monitor |

## Acceptance criteria

- Round-trip a bundle; reject cross-project references and path traversal; explicitly represent unknown commit and missing artifacts.
- A timed-out command retains its emitted marker and timeout reason; a spawn failure is visible; output-write failure cannot masquerade as complete evidence.
- An Electron fixture opens a failed check's retained log; keyboard navigation and theme captures cover failure and empty states.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments



## Review 2026-09-25

Status corrected from In Progress → Done. Verified in the current tree:

- Evidence contracts live in `packages/core/src/workflows/workflowEvidence.ts`
  (bundle/entry/source-ref types; imported across `workflowRunSummary`,
  `diagnosisBrief`, and `browserDiagnostics`).
- Retained evidence flows through the run pipeline: `workflowRunSummary.ts`
  carries check evidence into stage summaries.
- Core test coverage: `workflowEvidence` exercised via
  `directDeliveryJourney.test.ts` and `workflowRunSummary` tests.

Validation commands: `npm run check-types`, `npm run test:core`
(not rerun as part of this review).
