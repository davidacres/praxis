---
id: TASK-422
type: Task
status: Backlog
---

# TASK-422: Implement guarded connection transitions

**Type:** Task
**Status:** Backlog
**Priority:** High
**Model:** gpt-6-astra
**Created:** 2026-10-05

**Story:** [FX-BE-162](../story.md)

## Description

Implement switch/disconnect/cancel transitions and guard asynchronous reads, writes and callbacks, including rapid A-B-A switches.

## Dependencies

FX-BE-161

## Done conditions

- Deliver the stated scope and satisfy the parent story criteria relevant to this task.
- Add meaningful focused verification for failure modes and preserve existing single-desktop behaviour.
- Record commands, outcomes and remaining blockers in the story.

## Validation

Use the feature validation matrix and the parent story scenarios. Do not accept only a successful build as proof of a UI flow.

## Comments


