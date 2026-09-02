---
id: FX-BE-024
title: Orchestrator loop, check execution, and run worktrees
status: proposed
feature: FX-BF-013
issue: docs/issues/features/fx-bf-013-workflow-orchestration-runtime/stories/fx-be-024-orchestrator-loop-checks-worktrees/issue.md
updated: 2026-09-02
tasks: [TASK-111, TASK-112, TASK-113]
dependencies: [FX-BE-019, FX-BE-022]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# Orchestrator loop, check execution, and run worktrees

## User or operational impact

The deterministic half of a run — checks, joins, gate evaluation — advances on
its own against a stable snapshot, with no manual stage advancement.

## Scope

- A `WorkflowOrchestrator` service in the main process: on every run transition,
  compute `scheduleWorkflowRun`, dispatch each ready node by kind, apply the
  resulting `WorkflowRunCommand`s, persist, and re-schedule until nothing moves.
- Deterministic check execution: spawn `command` + `args` in the run worktree,
  honour `timeoutMs`, capture the exit code, write stdout/stderr as a
  `log` / `test-results` artifact, and apply `node-succeeded` when the code is in
  `successExitCodes` else `node-failed`.
- One git worktree per run, branched off the project's current branch, created
  on run start and removed on run end; the frozen implementation snapshot is a
  commit on that branch.

## Acceptance criteria

- Starting a run of a checks-and-joins-only workflow drives it to completion or
  a blocked state with no user action; the monitor explanation stays accurate.
- A check's exit code decides its gate; its output is inspectable as an artifact.
- Two mutating stages never run against the worktree at once (the scheduler
  already serialises them; the orchestrator must honour `ready`).
- A run worktree is created once, reused by every stage, and cleaned up when the
  run settles or is cancelled.

## Task list

- `TASK-111` — Add the `WorkflowOrchestrator` service and scheduler-driven dispatch.
- `TASK-112` — Implement deterministic check execution and artifact capture.
- `TASK-113` — Add the per-run git worktree lifecycle and frozen snapshots.

## Close when

A workflow whose only agent stage is stubbed runs its checks, joins, and gate
evaluation end to end against one per-run worktree, verified by a desktop test.
