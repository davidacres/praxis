# FX-BE-184: Durable team-chat release verification

**Type:** Story
**Status:** To Do
**Priority:** High

Canonical plan: [FX-BE-184](../../../../../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-184-release-proof/story.md).

## Impact and scope

Release confidence comes from fault injection, provider integration, full UI coverage and retained evidence.

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

## Validation and close conditions

Follow the canonical story and its task-specific tests; close only when all criteria have linked evidence. No external issue has been created.
