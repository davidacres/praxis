---
id: TASK-438
type: Task
status: Backlog
---

# TASK-438: Implement per-host preferences and safe click routing

**Type:** Task
**Status:** Backlog
**Priority:** Low
**Model:** gpt-6-astra
**Created:** 2026-10-05

**Story:** [FX-BE-169](../story.md)

## Description

Add notification settings and host-aware cold/warm launch routing; revalidate identity/access and never execute an approval from the notification.

## Dependencies

TASK-437

## Done conditions

- Deliver the stated scope and satisfy the parent story criteria relevant to this task.
- Add meaningful focused verification for failure modes and preserve existing single-desktop behaviour.
- Record commands, outcomes and remaining blockers in the story.
- If this task changes UI, interact with it end to end and visually inspect light/dark and compact/large modes. Preserve useful PNG evidence under .praxis/session-artifacts/ and publish an artifact gadget at handoff.

## Validation

Use the feature validation matrix and the parent story scenarios. Do not accept only a successful build as proof of a UI flow.

## Comments


