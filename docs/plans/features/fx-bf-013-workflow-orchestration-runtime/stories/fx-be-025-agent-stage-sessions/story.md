---
**Status:** 📋 Proposed
**Created:** 2026-09-02T00:54:54.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-025
title: Agent stage sessions and completion
status: complete
feature: FX-BF-013
issue: docs/issues/features/fx-bf-013-workflow-orchestration-runtime/stories/fx-be-025-agent-stage-sessions/issue.md
updated: 2026-09-02
tasks: [TASK-114, TASK-115, TASK-116]
dependencies: [FX-BE-020, FX-BE-024]
validation: [npm run build, npm run test:core, npm run test:desktop]
---

# Agent stage sessions and completion

## User or operational impact

An agent stage runs a real attributed session — not a manual button — and its
result flows back into the run as typed artifacts and a snapshot, visible in the
Sessions view tagged with its run and node.

## Scope

- Implement `WorkflowSessionPort` over the existing agent hosts: build an
  `AgentTaskDefinition` from the `WorkflowStageContext`, start the session with
  the binding's agent, skills, tool mode, and the run worktree.
- Wire completion: subscribe to `AiSessionManager` lifecycle; on a
  workflow-attributed session going terminal, extract typed artifacts from its
  output, commit the worktree for a mutating stage, and hand the orchestrator a
  `node-succeeded` / `node-failed`.
- Attribute the session: `workflowRunId` and `workflowNodeId` on
  `AgentSessionRecord`, surfaced in the Sessions list.

## Acceptance criteria

- `preflightStage` runs before a session starts; an untrusted, invalid,
  unavailable, or capability-incompatible agent fails the stage with its
  remediation and never opens a session.
- A completed stage records the artifacts its contract declared; a stage that
  produced none of its required artifacts fails regardless of what the agent
  reported.
- Cancelling a run cancels its in-flight stage sessions.
- The Sessions view shows a stage session labelled with its workflow run and
  node.

## Task list

- `TASK-114` — Implement `WorkflowSessionPort` over the agent hosts.
- `TASK-115` — Wire stage completion, artifact extraction, and the snapshot commit.
- `TASK-116` — Attribute stage sessions to their workflow run and node.

## Close when

An agent stage in the built-in template runs as a real session, preflighted and
attributed, and its diff and report reach the downstream gates.

## Description


## Dependencies



## Comments


