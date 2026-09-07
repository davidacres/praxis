---
type: Story
id: FX-BE-072
title: "Event-triggered bounded failure repair"
status: backlog
feature: FX-BF-027
updated: 2026-09-07
dependencies: [FX-BE-071]
---

# FX-BE-072: Event-triggered bounded failure repair

**Priority:** Low
**Created:** 2026-09-07

## Outcome

Add opt-in CI/review event automation only after manual diagnosis and deployment reconciliation are proven.

## Scope and implementation entry points

packages/core/src/workflows; CI provider adapters. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-071
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-195](tasks/task-195-define-event-subscription-and-deduplication.md) | Define event subscription and deduplication |
| 2 | [TASK-196](tasks/task-196-apply-automation-limits-and-approval-boundaries.md) | Apply automation limits and approval boundaries |
| 3 | [TASK-197](tasks/task-197-verify-opt-in-event-journeys.md) | Verify opt-in event journeys |

## Acceptance criteria

- Duplicate and out-of-order events produce one intended repair; UI states when desktop closure stops monitoring.
- Runaway repeated failures stop with a reason; new source revisions cannot reuse old approvals; unsupported spend enforcement remains explicitly advisory.
- No live webhook, paid model or production deployment is required for ordinary tests; document ownership and monitoring lifetime.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.
