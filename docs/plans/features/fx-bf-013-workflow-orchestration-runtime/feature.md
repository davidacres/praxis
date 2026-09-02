---
**Status:** 📋 Proposed
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-013
slug: workflow-orchestration-runtime
title: Workflow orchestration runtime
status: proposed
owner: Electron desktop app
updated: 2026-09-02
issues: docs/issues/features/fx-bf-013-workflow-orchestration-runtime/feature-issues.md
stories: [FX-BE-024, FX-BE-025, FX-BE-026]
validation: [npm run check-types, npm run build, npm run test:core, npm run test:desktop]
---

# FX-BF-013: Workflow orchestration runtime

## Outcome

A governed delivery workflow runs unattended: the app schedules ready stages,
runs deterministic checks and agent sessions against a frozen per-run worktree,
advances joins and gates, enforces timeouts, and keeps the run monitor live —
so a run reaches approval on its own and a person only decides.

## Scope

- A main-process orchestrator that reacts to run state, dispatches what
  `scheduleWorkflowRun` says is ready, applies the resulting commands, and
  re-schedules — the impure loop around FX-BE-019's pure engine.
- Deterministic check execution: spawn the command in the run worktree, capture
  the exit code and output as a typed artifact.
- One git worktree per run, branched off the project repo; mutating stages share
  it (already serialised), verification stages read it at the frozen snapshot.
- `WorkflowSessionPort` implemented over the existing agent hosts
  (`ai:delegate` / ACP / copilot / gateway), with the stage session attributed
  to its run and node and its completion wired back to the orchestrator.
- Timeout enforcement and a `workflows:runChanged` push channel so the monitor
  updates without user action.

## Story map

- `FX-BE-024` — Orchestrator loop, check execution, and run worktrees.
- `FX-BE-025` — Agent stage sessions and completion.
- `FX-BE-026` — Live updates, timeouts, and end-to-end verification.

## Dependencies

- `FX-BF-012` — the workflow engine, contracts, designer, and run monitor.
- `FX-BE-023` — folder persistence, so a committed workflow is what runs.
- Not blocked on `FX-BF-011`: the port wraps the agent execution that
  `ai:delegate` already performs. FX-BF-011 landing later only enriches the
  runtime side.

## Close when

The built-in Governed delivery workflow runs from a project task through
approval with no manual stage advancement, recovers after a restart without
re-running completed stages, and the monitor reflects every transition live.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
