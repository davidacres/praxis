---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-486
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-184
---

# TASK-486: Complete deterministic crash and provider contract coverage

Parent: [FX-BE-184](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Add core transaction/coordinator/context suites, main persistence/IPC recovery tests, mock API and scripted real ACP-wire fixtures. Register all new test files in actual npm scripts and the Praxis test catalog.

## Dependencies

TASK-485

## Acceptance criteria

- Every feature acceptance criterion maps to a named assertion and artifact in a verification report; no skipped test is reported as passed.
- Exercise file-write errors, malformed data, duplicate commands/events, concurrent windows, missing provider resume and every crash boundary.
- Fixtures use temporary profiles, repositories and coordination roots; no test points a Praxis write path at working-tree plans or user data.
- Run an opt-in real API and real CLI continuation/restart check with retained attempt IDs and context evidence; report credentials/capacity blockers honestly without substitution by mocks.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments

## Scheduled delivery and verification ownership

Follow the parent feature's scheduled execution contract. The process runs this task's checks and performs visual inspection immediately when visible behavior changes, retaining useful screenshots. Human review is deferred until all twelve tasks are delivered. Record the prerequisite/result commits and evidence in the task handoff; do not execute against a base missing predecessor changes or bypass an approval gate to advance the queue.
