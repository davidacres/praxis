---
**Status:** ✅ Complete
**Created:** 2026-09-17T21:31:56.564Z
**Type:** Feature
**Priority:** Medium
type: Feature
id: FX-BF-040
slug: connected-agent-workflow-sessions
title: Connected agent workflow sessions and governed delivery
status: Done
owner: Electron desktop app
updated: 2026-09-25
issues: docs/issues/features/fx-bf-040-connected-agent-workflow-sessions/feature-issues.md
stories: [FX-BE-123, FX-BE-124, FX-BE-125, FX-BE-126, FX-BE-127, FX-BE-128]
validation: [npm run check-types, npm run build:core, npm run build:renderer, npm run build:desktop, npm run test:core, npm run test:desktop]
---

# FX-BF-040: Connected agent workflow sessions and governed delivery

## Outcome

An agent session can choose a governed workflow, and that choice becomes an
auditable `WorkflowRun` which executes the workflow's stages through the
selected Agent Hub binding. Profiles provide role and constraints, skills
provide reusable capabilities, runtime hosts provide the actual transport,
providers provide model/service access, and the orchestrator owns stage order,
artifacts, gates, approvals, and recovery.

## Product decision

The user's session is the entry point and control surface for a workflow, but a
single chat turn does not self-advance the whole graph. Selecting a workflow
must create or attach a `WorkflowRun`; the run owns the immutable definition
snapshot and the orchestrator starts one attributed stage session per agent
node. The originating session shows the run, asks for decisions when a gate
needs a person, and can continue with the run's context. This preserves the
meaning of gates and prevents an agent from claiming downstream approval by
writing instructions into its own chat.

The canonical executable workflow is `WorkflowDefinition`. A workflow pack is
optional stage guidance, not a second scheduler. Existing issue-level workflow
pack assignments remain readable during migration, but new execution paths
must resolve through a governed workflow definition.

## Scope

- Make workflow selection a first-class session action with readiness and
  effective-policy feedback before a run starts.
- Make the selected Agent Hub profile, runtime host, provider, skills, tool
  mode, trust state, and capabilities the authoritative binding for both
  interactive sessions and workflow stage sessions.
- Resolve workflow packs and skills into the stage task and record whether each
  capability was native, tool-backed, or context-only.
- Link the originating session, every stage session, the workflow definition
  snapshot, node, artifacts, gate outcomes, approvals, and worktree into one
  navigable audit trail.
- Connect the Workflow Designer and Task Designer to the same executable
  workflow model without collapsing ticket planning into workflow execution.
- Make gate and approval controls node-specific, durable, policy-aware, and
  safe across retry and app restart.
- Migrate legacy prompt-only workflow assignments without breaking existing
  sessions or silently changing their behavior.

## Current seams this plan closes

- `aiIpc.ts` and `workflowAgentStage.ts` resolve Agent Hub metadata but still
  launch through the configured provider adapter rather than the selected
  runtime-host transport.
- The issue workflow catalog injects `.github/skills/<pack>/SKILL.md` as
  prompt guidance; it does not start `WorkflowOrchestrator` or enforce gates.
- `WorkflowAgentTaskNode.workflowPackId` is validated but is not resolved into
  the stage task or prompt.
- Workflow Designer edits the executable graph, while Task Designer produces a
  planning canvas/master plan; there is no explicit promotion/link to a run.
- Multiple approval nodes can exist, but some IPC and summary paths address the
  first approval node instead of the selected node.

## Story map

- `FX-BE-123` — Workflow selection and session/run linkage.
- `FX-BE-124` — Agent Hub host execution for interactive and stage sessions.
- `FX-BE-125` — Workflow packs and skill activation inside governed stages.
- `FX-BE-126` — Workflow Designer and Task Designer integration.
- `FX-BE-127` — Gate evaluation, approvals, and run operations.
- `FX-BE-128` — Migration, observability, compatibility, and end-to-end proof.

## Dependencies

- `FX-BF-009`, `FX-BF-010`, and `FX-BF-011` — Agent Hub catalog, authoring,
  trust, and session handoff.
- `FX-BF-012` and `FX-BF-013` — governed workflow contracts, orchestrator,
  stage sessions, artifacts, and persistence.
- `FX-BF-014` — Workflow Designer and Run Monitor surfaces.
- `FX-BF-015` and `FX-BF-017` — session inspection and ticket-triggered entry
  points.
- `FX-BF-038` — canonical provider, host, profile, skill, binding, and session
  terminology.

## Risks or open questions

- A runtime host is executable code and must remain behind trust, scope,
  fingerprint, capability, sandbox, and tool-mode checks; catalog presence is
  not execution permission.
- A user may expect “select workflow” to mean one conversation follows every
  stage. The plan deliberately models one control session plus attributed
  stage sessions so approval and worktree boundaries remain enforceable.
- Existing workflow packs may contain ordering guidance that has no graph
  equivalent. Migration must preserve prompt-only behavior until an explicit
  governed workflow is selected.
- The initial host-adapter slice should prove one real ACP host end to end,
  then add other transports behind the same port rather than pretending a
  generic process spawn is a working protocol adapter.

## Close when

From New Session, a user can select a ready governed workflow and a compatible
Agent Hub binding, start it against a task, watch the originating session and
stage sessions in one run history, observe artifacts and gate outcomes, answer
the correct approval node, recover the run after restart, and verify that the
selected host and skills—not merely attribution metadata—were used. Existing
legacy sessions and prompt-only packs still open and behave as before.

## Delivery order

1. Define the session/workflow/run and binding contracts.
2. Make host adapters authoritative for session and stage launch.
3. Resolve workflow packs and skills as governed stage inputs.
4. Connect both designers and the session/run navigation.
5. Harden gate, approval, retry, and recovery operations.
6. Migrate, instrument, and prove the complete path with deterministic and
   real-host fixtures.

## Review 2026-09-25 — status corrected from Proposed to Done

All six stories were found shipped in the codebase during the board review;
the feature and its story tickets were left stale at Planned (updated
2026-09-17). Governed workflow selection, run snapshots, host-adapter
launches, pack and skill activation, designer promotion, node-specific
approvals with policy-checked bypass, migration, and diagnostics are present
and exercised by the core test suite.

Verified in this review: `npm run build:core` and `npm run test:core`
(1311 tests, 0 failures). Desktop build/e2e commands were unavailable in this
session, so re-run them before release.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments
