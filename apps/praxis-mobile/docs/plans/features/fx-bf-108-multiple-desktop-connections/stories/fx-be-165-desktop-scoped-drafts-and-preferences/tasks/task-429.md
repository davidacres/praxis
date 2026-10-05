---
id: TASK-429
type: Task
status: Backlog
---

# TASK-429: Restore scoped state and verify pending actions

**Type:** Task
**Status:** Backlog
**Priority:** High
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

**Story:** [FX-BE-165](../story.md)

## Description

Integrate safe restore; test equal session/project IDs on two hosts, lost project grants and switching with unsent text, attachments or a pending approval.

## Dependencies

TASK-428, FX-BE-162

## Done conditions

- Deliver the stated scope and satisfy the parent story criteria relevant to this task.
- Add meaningful focused verification for failure modes and preserve existing single-desktop behaviour.
- Record commands, outcomes and remaining blockers in the story.
- If this task changes UI, interact with it end to end and visually inspect light/dark and compact/large modes. Preserve useful PNG evidence under .praxis/session-artifacts/ and publish an artifact gadget at handoff.

## Validation

Use the feature validation matrix and the parent story scenarios. Do not accept only a successful build as proof of a UI flow.

## Comments


