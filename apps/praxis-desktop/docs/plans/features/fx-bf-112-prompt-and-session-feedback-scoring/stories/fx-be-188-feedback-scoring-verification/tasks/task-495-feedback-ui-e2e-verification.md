---
**Status:** To Do
**Created:** 2026-10-28
**Type:** Task
**Priority:** High
id: TASK-495
type: Task
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
feature: FX-BF-112
story: FX-BE-188
---

# TASK-495: Verify composer and session feedback journeys in Playwright E2E

Parent: [FX-BE-188](../story.md). Design: [FX-BF-112](../../../feature.md).

## Goal and scope

Create `apps/praxis-desktop/main/e2e/sessionFeedback.spec.ts`. Drive the built desktop app through: (1) scoring a vague draft prompt in the composer and applying one-click remediations to raise the deterministic score, and (2) opening a completed session's Feedback & Score panel, verifying the audited tools/skills/agent/MCP inventory and 5-dimension breakdown, submitting human feedback (`needs-work` + friction tags + notes), and confirming the updated score and badge persist.

## Dependencies

TASK-492, TASK-493, TASK-494

## Acceptance criteria

- E2E spec verifies pre-send prompt scoring and one-click skill/mode remediation in the composer.
- E2E spec verifies post-session deterministic scorecard breakdown, capability audit, feedback submission, and persistence.
- Visual verification screenshots of the composer prompt check and session scorecard are captured in `.praxis/session-artifacts/`.

## Validation

Run `npm run build && npm run test:e2e --workspace=@praxis/desktop-main -- sessionFeedback.spec.ts --project=functional`.

## Done when

All E2E assertions pass and visual artifacts are recorded.

## Description


## Comments
