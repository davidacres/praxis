---
id: FX-BE-123
title: Workflow selection and session/run linkage
status: Planned
feature: FX-BF-040
issue: docs/issues/features/fx-bf-040-connected-agent-workflow-sessions/stories/fx-be-123-workflow-selection-and-session-run-linkage/issue.md
updated: 2026-09-17
tasks: [TASK-335, TASK-336, TASK-337]
dependencies: [FX-BF-012, FX-BF-013, FX-BF-014, FX-BF-038]
validation: [npm run check-types, npm run build:desktop, npm run test:desktop]
---

# Workflow selection and session/run linkage

Parent feature folder: `fx-bf-040-connected-agent-workflow-sessions`

## User or operational impact

Users can start a session with a named governed workflow and can tell whether
they are chatting with the workflow controller, an active stage, or a completed
run. The workflow is no longer an untracked prompt choice.

## Scope

- Add workflow selection to the New Session composer and relevant ticket Start
  AI entry points.
- Resolve definition readiness, binding readiness, effective policy, and
  required inputs before creating a run.
- Persist the selected workflow identity/version, originating session, run,
  and stage-node links without changing historical session records.

## Acceptance criteria

- A session can select none, a governed workflow, or a workflow template that
  is instantiated into a governed definition before execution.
- A selected workflow cannot start when its graph, agent binding, skills,
  trust, folder, or policy prerequisites are invalid; the UI explains the
  blocking reason.
- Starting a workflow creates one immutable `WorkflowRun` snapshot and links
  it to the originating session; each stage session links back to run and node.
- Reopening either the session or the run exposes the same relationship after
  an app restart.

## Task list

- `TASK-335` — Define workflow-selection, controller-session, and run-link contracts.
- `TASK-336` — Add session composer selection, readiness, and start flow.
- `TASK-337` — Persist and navigate controller, stage, run, and node attribution.

## Validation

- Core contract/store tests for new and legacy session records.
- Desktop E2E for select workflow → start run → reopen session/run.

## Close when

The user can select a real governed workflow from a session entry point and the
resulting run is visible and durable from both sides of the relationship.
