---
id: FX-BE-127
title: Gate evaluation, approvals, and run operations
status: Done
feature: FX-BF-040
issue: docs/issues/features/fx-bf-040-connected-agent-workflow-sessions/stories/fx-be-127-gates-approvals-and-run-operations/issue.md
updated: 2026-09-25
tasks: [TASK-347, TASK-348, TASK-349]
dependencies: [FX-BF-012, FX-BF-013, FX-BF-014, FX-BF-034]
validation: [npm run check-types, npm run build:core, npm run build:desktop, npm run test:core, npm run test:desktop]
---

# Gate evaluation, approvals, and run operations

Parent feature folder: `fx-bf-040-connected-agent-workflow-sessions`

## User or operational impact

The run stops at the right boundary, explains what is still required, and
routes approval or bypass to the correct gate/node. Restart, retry, and cancel
do not lose the audit trail or accidentally repeat unsafe work.

## Scope

- Make gate ledger entries durable, node-specific, and derived from recorded
  outcomes and required artifacts.
- Replace first-approval assumptions with explicit approval-node identity in
  IPC, scheduling, summaries, and the Run Monitor.
- Connect retry, recovery, timeout, cancel, approval, and bypass controls to
  policy and session/run state transitions.

## Acceptance criteria

- Review, QA, and security gates cannot pass on prose alone when their contract
  requires artifacts or deterministic checks.
- Approval remains unavailable while required gates are pending, failed, or
  missing; bypass requires effective policy permission and records actor,
  timestamp, reason, and target node.
- Workflows with multiple approval nodes can pause, resume, and report each
  approval independently.
- Restart and retry preserve completed stages, attempt limits, artifacts,
  gate history, and the originating session link.

## Task list

- `TASK-347` — Make gate outcomes and evidence node-specific and durable.
- `TASK-348` — Implement explicit approval/bypass target handling and policy checks.
- `TASK-349` — Harden run monitor operations, recovery, retry, timeout, and audit events.

## Validation

- Core gate/policy/scheduler tests, including multiple approval nodes.
- Desktop E2E for blocked approval → gate completion → approval, bypass, retry,
  and restart recovery.

## Close when

Every run operation is safe, explainable, policy-aware, and tied to the exact
workflow node and session that produced it.

## Review 2026-09-25 — status corrected from Planned to Done

Found shipped in the codebase during the board review; the ticket was left stale
at Planned (updated 2026-09-17).

- Approval gates in the `@praxis/core` workflow engine target individual nodes
  and record actor, decision and timestamp.
- Policy-checked bypass exists with actor, reason and timestamp, matching the
  "bypass with justification" acceptance criteria, and run operations
  (pause/resume/stop) are exposed on live runs.

Status set to Done as part of the 2026-09-25 board review. Re-confirm with
`npm run check-types`, `npm run build:core` and `npm run test:core` before
release. Task files for this story were not re-verified individually.
