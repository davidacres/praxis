---
**Status:** ✅ Complete
**Created:** 2026-09-30T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-389
title: Add bounded QA self-healing to governed delivery
status: Done
story: FX-BE-022
updated: 2026-09-30
dependencies: [TASK-104, TASK-105]
validation: [npm run build:core, npm run check-types, node --test ../../packages/core/out/workflows/workflowValidation.test.js ../../packages/core/out/workflows/workflowTemplates.test.js ../../packages/core/out/workflows/workflowRun.test.js ../../packages/core/out/workflows/workflowOrchestrator.test.js]
---

# TASK-389: Add bounded QA self-healing to governed delivery

## Goal

Allow the governed delivery QA check to take a deterministic success path or a
bounded failure-recovery path, while keeping QA as a real deterministic gate.

## Issue description

The governed delivery workflow already supported `success` and `failure` edges
for both deterministic checks and agent tasks, but the DAG validator rejected a
direct `QA → repair agent → QA` cycle. That meant QA could be retried or
diagnosed manually, but it could not safely self-heal through an agent and then
re-run verification as part of the same governed run.

## Completed implementation

- Added `failureRecovery` metadata to check nodes. It identifies a mutating
  `agent-task` repair node and a positive recovery-attempt limit.
- Added validation requiring the repair target to be a mutating agent task
  reached by the check's failure edge.
- Persisted per-source recovery counts in `WorkflowRun` and applied the budget
  in scheduling and orchestration.
- On successful repair, reopened QA and invalidated/re-ran the other
  verification and approval evidence against the new committed snapshot.
- When the recovery budget is exhausted, the repair branch is skipped and the
  normal required-stage failure/manual diagnosis behavior remains in force.
- Updated the built-in governed delivery template with a `Repair QA failures`
  agent task capped at two recovery attempts.
- Documented the new behavior in the governed delivery workflow guide.

## Done when

- A QA check can route success to the normal gates branch and failure to a
  bounded repair agent.
- A successful repair reopens QA without permitting an unbounded graph loop.
- Review, build, install, security, and approval evidence cannot remain trusted
  from before the repair snapshot.
- Exhausted recovery remains visible as a failed QA gate with manual recovery
  available.
- The workflow definition and persisted run state round-trip without dropping
  recovery configuration or counts.

## Description

This task implements the recommended first-class bounded recovery policy rather
than encoding repeated QA/repair stages manually in the graph. Agent tasks and
checks continue to use the same success/failure edge model; recovery is an
explicit controlled loop handled by the run engine so the workflow remains an
acyclic, auditable DAG.

## Dependencies

- `TASK-104`
- `TASK-105`

## Comments

- **Implementation completed:** Updated workflow contracts, normalization and
  validation, run persistence, scheduler edge handling, orchestrator recovery,
  the governed delivery template, and workflow documentation.
- **Behavior completed:** QA failure enters `Repair QA failures`; a successful
  repair creates a new revision and reopens verification. Two exhausted repair
  attempts leave the QA gate failed and preserve manual retry/diagnosis.
- **Verification completed:** `npm run build:core` passed; `npm run check-types`
  passed across core, main, renderer, and mobile protocol; the focused workflow
  suite passed all 144 tests; and `git diff --check` passed.
- **Scope note:** No renderer surface changed, so visual screenshot verification
  was not applicable.
