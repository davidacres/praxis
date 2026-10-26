---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Story
**Priority:** High
id: FX-BE-184
type: Story
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
issue: docs/issues/features/fx-bf-111-durable-team-chat/stories/fx-be-184-release-proof/issue.md
---

# FX-BE-184: Durable team-chat release verification

Parent: [FX-BF-111](../../feature.md). Issue mirror: [FX-BE-184](../../../../../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-184-release-proof/issue.md).

## User or operational impact

Release confidence comes from fault injection, provider integration, full UI coverage and retained evidence.

## Scope

- Add core transaction/coordinator/context suites, main persistence/IPC recovery tests, mock API and scripted real ACP-wire fixtures. Register all new test files in actual npm scripts and the Praxis test catalog.
- Build/copy the renderer, run focused assistant and standalone-conversation checks then the full functional suite and applicable theme checks. Manually interact with the built assistant surfaces and preserve useful screenshots. Update scoped catalog entries and record unrelated failures without hiding them.

## Dependencies

FX-BE-183

## Acceptance criteria

- 486: Every feature acceptance criterion maps to a named assertion and artifact in a verification report; no skipped test is reported as passed.
- 486: Exercise file-write errors, malformed data, duplicate commands/events, concurrent windows, missing provider resume and every crash boundary.
- 486: Fixtures use temporary profiles, repositories and coordination roots; no test points a Praxis write path at working-tree plans or user data.
- 486: Run an opt-in real API and real CLI continuation/restart check with retained attempt IDs and context evidence; report credentials/capacity blockers honestly without substitution by mocks.
- 487: All prescribed implementation commands in the feature pass or have explicit unresolved blocker evidence; unresolved feature acceptance failures prevent closing this feature.
- 487: Manual verification covers dock/float, both sidebars, second window, restart, permissions, queue, cancel/retry, context-required and outcome_unknown resolution.
- 487: Useful screenshots remain under .praxis/session-artifacts/ and are handed off as artifact gadgets; snapshot updates include inspection of actual and diff images.
- 487: The final report separates deterministic, real-provider, full-suite and visual evidence; existing user data remains intact and rollback limitations are documented.

## Tasks

- [TASK-486: Complete deterministic crash and provider contract coverage](tasks/task-486-failure-matrix-tests.md)
- [TASK-487: Verify built desktop UI and record release evidence](tasks/task-487-desktop-release-verification.md)

## Validation

Use the parent feature acceptance-to-suite mapping and validation commands. Each task supplies executable scenarios; record exact commands, assertion names and artifacts. This story does not close on typechecking alone.

## Close when

Both tasks satisfy every acceptance criterion, results are linked here and in the issue mirror, and no story-specific recovery or compatibility gap remains.

## Description


## Comments
