---
id: TASK-426
type: Task
status: Backlog
---

# TASK-426: Make pairing additive and identity-aware

**Type:** Task
**Status:** Backlog
**Priority:** High
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

**Story:** [FX-BE-164](../story.md)

## Description

Separate candidate configuration from saved registry and handle successful upsert, duplicate identity, changed key and discovery route updates.

## Dependencies

FX-BE-161, FX-BE-162

## Done conditions

- Deliver the stated scope and satisfy the parent story criteria relevant to this task.
- Add meaningful focused verification for failure modes and preserve existing single-desktop behaviour.
- Record commands, outcomes and remaining blockers in the story.
- If this task changes UI, interact with it end to end and visually inspect light/dark and compact/large modes. Preserve useful PNG evidence under .praxis/session-artifacts/ and publish an artifact gadget at handoff.

## Validation

Use the feature validation matrix and the parent story scenarios. Do not accept only a successful build as proof of a UI flow.

## Comments


