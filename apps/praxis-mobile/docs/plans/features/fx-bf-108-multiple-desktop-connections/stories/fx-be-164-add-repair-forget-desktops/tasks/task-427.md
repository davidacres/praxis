---
id: TASK-427
type: Task
status: Backlog
---

# TASK-427: Add scoped repair and forget flows

**Type:** Task
**Status:** Backlog
**Priority:** High
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

**Story:** [FX-BE-164](../story.md)

## Description

Implement named local forget confirmation, revoked-access repair and failed pairing recovery; test A remains usable after B is added/forgotten.

## Dependencies

TASK-426, FX-BE-163

## Done conditions

- Deliver the stated scope and satisfy the parent story criteria relevant to this task.
- Add meaningful focused verification for failure modes and preserve existing single-desktop behaviour.
- Record commands, outcomes and remaining blockers in the story.
- If this task changes UI, interact with it end to end and visually inspect light/dark and compact/large modes. Preserve useful PNG evidence under .praxis/session-artifacts/ and publish an artifact gadget at handoff.

## Validation

Use the feature validation matrix and the parent story scenarios. Do not accept only a successful build as proof of a UI flow.

## Comments


