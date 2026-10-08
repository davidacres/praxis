---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-163
type: Story
status: Backlog
created: 2026-10-08
priority: High
featureId: 108
---

# Loop context and retry memory

## Impact

A stage that runs again is told what went wrong and what was already tried, so a retry converges instead of repeating its mistake. Today a retry only moves one model tier up.

## Scope

`workflowAgentStage.ts` (brief assembly beside `formatUpstreamReports` / `formatUpstreamLogs`), `workflowStageTask.ts`, `workflowRun.ts` attempt records. The handoff rule stays closed: a stage receives structured artifacts and findings, never an upstream transcript. Applies to loop-edge re-entry and to ordinary retries (including `failureRecovery` repairs).

## Acceptance criteria

- A stage entered on iteration N > 1, or retried after a failed attempt, receives an "Iteration N of M" section containing: the findings that triggered it (structured, file/line/severity/suggestion), its own previous outcome and error, and a short per-iteration history of what changed.
- The previous attempt's failure reason is included for ordinary retries too, verified by a test that fails today (a retry brief with no prior-error text).
- The section is capped like reports (head and tail kept, the cap announced) and findings are deduplicated by their stable fingerprint so a recurring finding is marked "raised again" rather than listed as new.
- The brief names findings already marked waived so the stage does not re-fix them.
- `QA repair` receives the failing check's log (already inlined) and the review findings that are still open, not only the diff.
- An attempt that paused (provider limit / environment) contributes nothing to the history, matching `attemptsSpent`.
- Memory is derived from the run record, not stored separately, so it cannot drift and survives recovery.

## Dependencies

FX-BE-162

## Description

Give re-run and retried stages the findings and history they need.

## Comments
