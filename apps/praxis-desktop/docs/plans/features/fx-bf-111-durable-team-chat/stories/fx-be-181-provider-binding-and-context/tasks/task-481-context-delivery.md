---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-481
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-181
---

# TASK-481: Build versioned context with delivery receipts and summaries

Parent: [FX-BE-181](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Replace the assistant fixed 12-message/3000-character history path for durable chats with the context protocol below. Persist summary provenance and user-pinned decisions. Native resume receives only missing shared context, while stateless calls receive a bounded reconstructed view.

## Dependencies

TASK-480

## Acceptance criteria

- Native continuation does not repeat that member's own completed reply or earlier delivered messages; other members' replies and intervening turns arrive once at the logical delivery boundary.
- A fresh binding receives instructions, pinned decisions, a versioned summary, recent messages and the current turn exactly once; queued future turns are excluded.
- A long fixture exceeding the former limits preserves an early pinned decision and resolves a later correction using source message IDs.
- Unavailable summarization or an oversized pinned/current context causes visible context-required status rather than silent omission or an over-limit provider call.
- Uncertain prompt acceptance invalidates the delivery cursor and triggers recovery; the coordinator never blindly resends into an uncertain native session.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments

## Scheduled delivery and verification ownership

Follow the parent feature's scheduled execution contract. The process runs this task's checks and performs visual inspection immediately when visible behavior changes, retaining useful screenshots. Human review is deferred until all twelve tasks are delivered. Record the prerequisite/result commits and evidence in the task handoff; do not execute against a base missing predecessor changes or bypass an approval gate to advance the queue.
