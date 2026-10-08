---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-426
slug: iteration-brief-and-retry-memory
title: Iteration brief: triggering findings, prior outcome and history
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 163
---

# TASK-426: Iteration brief: triggering findings, prior outcome and history

## Description

Add an iteration section to the stage brief assembled in `workflowAgentStage.ts` and `workflowStageTask.ts`, derived from the run record: iteration N of M, the findings that triggered the stage (structured), the stage's previous outcome and error, and a compact per-iteration history. Include the previous failure reason for ordinary retries.

## Acceptance criteria

- A first-iteration stage's brief is byte-identical to today's.
- Findings are capped like reports, deduplicated by fingerprint, and a repeated finding is labelled "raised again (iteration N)".
- Waived findings are named so they are not re-fixed.
- The QA repair stage receives open review findings as well as the QA log.
- Paused attempts (`pause` set) contribute nothing, matching `attemptsSpent`.
- Unit tests build the brief from fixture runs; a test that retries a failed stage proves the prior error text is present (it is absent today).

## Dependencies

- TASK-424

## Comments
