---
**Status:** 📋 Proposed
**Created:** 2026-09-06T13:13:26.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-041
title: Wire workflow failures into the Output tab's log bus
status: Done
feature: FX-BF-017
issue: docs/issues/features/fx-bf-017-ai-session-ux-and-workflow-ticket-integration/stories/fx-be-041-workflow-log-sink/issue.md
updated: 2026-09-06
commits: [acd5bbe]
dependencies: [FX-BE-040]
validation: [npm run check-types, npm run test:desktop]
---

# Wire workflow failures into the Output tab's log bus

## User or operational impact

The Output tab already tailed the shared log bus for AI sessions and
Jira/GitLab backend calls (`[ai]` / `[jira]` / `[gitlab]` tags), but the
workflow subsystem never wired in. A write-back failure, or a worktree snapshot
that couldn't be frozen, went to a bare `console.error` no UI ever surfaces —
discoverable only with a main-process console attached.

## As built (`acd5bbe`)

- New `workflowLogSink.ts`: a `[workflow]`-tagged tee of the log bus,
  colocated **outside** both consumers to avoid an import cycle
  (`workflowAgentStage.ts` is imported by `workflowOrchestratorInstance.ts`).
- Two existing bare `console.error` calls routed through it: a write-back
  failure in `writeBackToIssue`, and a worktree-snapshot failure in
  `freezeWorktree`.

## The deliberate non-goal

This is **not** a blanket per-stage-failure logger. A run's own stage failures
and timeouts already appear in the run monitor's timeline and stage detail
(they are part of `WorkflowRun.events`); mirroring them into the global bus
would only duplicate that UI. This story covers **only** failures with no other
visible surface at all.

## Acceptance criteria — verified

- A write-back failure (e.g. a ticket that no longer exists) appears in the
  Output tab tagged `[workflow]`, including the run id and ticket key.
- Ordinary stage failures/timeouts, already visible in the run monitor, are not
  duplicated into the global log.

## Tests

`workflowRun.spec.ts` (e2e).

## Description


## Dependencies



## Comments


