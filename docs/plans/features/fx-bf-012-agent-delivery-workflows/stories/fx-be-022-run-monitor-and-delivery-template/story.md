---
type: Story
id: FX-BE-022
title: Run monitor, delivery template, and end-to-end verification
status: complete
feature: FX-BF-012
issue: docs/issues/features/fx-bf-012-agent-delivery-workflows/stories/fx-be-022-run-monitor-and-delivery-template/issue.md
updated: 2026-09-02
tasks: [TASK-104, TASK-105, TASK-106]
dependencies: [FX-BE-019, FX-BE-020, FX-BE-021]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# Run monitor, delivery template, and end-to-end verification

## User or operational impact

Users can operate a complete governed delivery pipeline and understand exactly why it is running, blocked, or complete.

## Scope

- Ship the built-in Plan → Implement → Review/QA/Security → Approval template.
- Add live run visualization, artifacts/evidence inspection, approval, retry, cancel, and recovery actions.
- Verify the complete flow in packaged desktop E2E and document observable run behavior.

## Acceptance criteria

- Review, QA, and security branches visibly converge before approval.
- Required failures block completion and expose actionable evidence.
- Restarting the app restores the run monitor and does not duplicate completed stage work.

## Task list

- `TASK-104` — Define and register the built-in governed delivery template.
- `TASK-105` — Implement run monitor, evidence view, approval, retry, and cancellation UI.
- `TASK-106` — Add packaged desktop E2E, accessibility, visual verification, and documentation.

## Close when

The built-in workflow completes from a project task through approval with every transition and artifact visible and tested.
