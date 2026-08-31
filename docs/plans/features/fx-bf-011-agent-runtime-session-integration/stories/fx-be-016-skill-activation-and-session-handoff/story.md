---
id: FX-BE-016
title: Skill activation and session handoff
status: proposed
feature: FX-BF-011
issue: docs/issues/features/fx-bf-011-agent-runtime-session-integration/stories/fx-be-016-skill-activation-and-session-handoff/issue.md
updated: 2026-08-31
tasks: [TASK-088, TASK-089]
dependencies: [FX-BE-015]
validation: [npm run check-types, focused Sessions and Agent Hub Playwright tests]
---

# Skill activation and session handoff

## Impact

Users can move from choosing an agent and skill into actual work without reconfiguring the session manually.

## Scope

- Activate skills against trusted agents.
- New session with selected agent and skill context.
- Links from runtime state to Sessions and completed work.

## Acceptance criteria

- Activation uses the negotiated native, tools, or context mode.
- New sessions retain selected agent and active skill context.
- Sessions remains the canonical conversation and event history.

## Close when

An Agent Hub selection launches a correctly attributed session and links back to its runtime context.
