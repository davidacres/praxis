---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-487
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-184
---

# TASK-487: Verify built desktop UI and record release evidence

Parent: [FX-BE-184](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Build/copy the renderer, run focused assistant and standalone-conversation checks then the full functional suite and applicable theme checks. Manually interact with the built assistant surfaces and preserve useful screenshots. Update scoped catalog entries and record unrelated failures without hiding them.

## Dependencies

TASK-486

## Acceptance criteria

- All prescribed implementation commands in the feature pass or have explicit unresolved blocker evidence; unresolved feature acceptance failures prevent closing this feature.
- Manual verification covers dock/float, both sidebars, second window, restart, permissions, queue, cancel/retry, context-required and outcome_unknown resolution.
- Useful screenshots remain under .praxis/session-artifacts/ and are handed off as artifact gadgets; snapshot updates include inspection of actual and diff images.
- The final report separates deterministic, real-provider, full-suite and visual evidence; existing user data remains intact and rollback limitations are documented.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Needs

What this ticket needs that a scheduled run cannot provide by itself. Praxis does not read this section yet; it will ask for these before a run starts.

- **person:** the manual verification list: dock/float, both sidebars, second window, restart, permissions, queue, cancel/retry, context-required and outcome_unknown resolution.
- **release-level:** the full functional suite and theme checks. Scheduled runs refuse the full desktop e2e suite, so a person runs these after the schedule.
- **In a scheduled run:** run the focused assistant and standalone-conversation checks and the desktop smoke suite, capture screenshots of the surfaces it can drive, and record the manual list and the full-suite run as handed to a person, as unresolved blocker evidence in the final report. Do not stop the stage as blocked for these.

## Description


## Comments

## Scheduled delivery and verification ownership

Follow the parent feature's scheduled execution contract. The process runs this task's checks and performs visual inspection immediately when visible behavior changes, retaining useful screenshots. Human review is deferred until all twelve tasks are delivered. Record the prerequisite/result commits and evidence in the task handoff; do not execute against a base missing predecessor changes or bypass an approval gate to advance the queue.
