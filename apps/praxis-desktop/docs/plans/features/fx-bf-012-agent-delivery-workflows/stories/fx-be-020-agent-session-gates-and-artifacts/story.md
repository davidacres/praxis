---
**Status:** ✅ Complete
**Created:** 2026-09-01T23:09:52.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-020
title: Agent session stages, gates, artifacts, and approvals
status: Done
feature: FX-BF-012
issue: docs/issues/features/fx-bf-012-agent-delivery-workflows/stories/fx-be-020-agent-session-gates-and-artifacts/issue.md
updated: 2026-10-10
tasks: [TASK-098, TASK-099, TASK-100]
dependencies: [FX-BE-018, FX-BE-019, FX-BF-009, FX-BF-011]
validation: [npm run build:core, npm run build:desktop, npm run test:core, npm run test:desktop]
---

# Agent session stages, gates, artifacts, and approvals

## User or operational impact

Each workflow stage runs through the trusted Agent Hub/runtime boundary and produces inspectable evidence instead of an untracked prompt chain.

## Scope

- Bind stages to discovered agents, skills, capabilities, workspace, and enforced tool mode.
- Create attributed sessions with declared inputs/outputs and concise artifact handoffs.
- Add deterministic checks, human approvals, audit events, and fail-closed trust/capability preflight.

## Acceptance criteria

- An untrusted, invalid, unavailable, or capability-incompatible agent cannot start a stage.
- Review, QA, and security inspect the implementation snapshot and cannot be marked passed by prose alone.
- Approval is unavailable until all required gates pass; optional bypasses record user, time, and reason.

## Task list

- `TASK-098` — Add stage preflight and Agent Hub/runtime binding.
- `TASK-099` — Extend session lifecycle with workflow run/node attribution and typed artifacts.
- `TASK-100` — Implement deterministic checks, approval gates, audit events, and policy enforcement.

## Close when

A workflow run visibly links every stage to its agent session, inputs, outputs, evidence, and gate decision.

## Description


## Dependencies



## Comments

**2026-10-10:** Status rollup corrected during backlog review: every task under this story is already Complete, so the story is Done.
