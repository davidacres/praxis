---
type: Story
id: FX-BE-052
title: "Bounded diagnose and verify workflow"
status: complete
feature: FX-BF-021
updated: 2026-09-09
dependencies: [FX-BE-051]
---

# FX-BE-052: Bounded diagnose and verify workflow

**Priority:** High
**Created:** 2026-09-07

## Outcome

Add a Diagnose action that reproduces a failure in an isolated worktree, records hypotheses and changes, and verifies the fix with deterministic checks.

## Scope and implementation entry points

packages/core/src/ai; packages/core/src/workflows; renderer/src/ai. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-051
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-135](tasks/task-135-create-diagnosis-sessions-from-evidence.md) | Create diagnosis sessions from evidence |
| 2 | [TASK-136](tasks/task-136-bound-repair-attempts-and-freshness.md) | Bound repair attempts and freshness |
| 3 | [TASK-137](tasks/task-137-show-diagnosis-and-verified-outcomes.md) | Show diagnosis and verified outcomes |

## Acceptance criteria

- A scripted ACP fixture receives the intended revision and evidence; folderless and read-only sessions explain why repair cannot start.
- An unresolved reproduction stops with an actionable reason; stale green checks cannot pass a repaired snapshot; cancellation stops local child processes.
- A seeded failing test is repaired by a scripted agent and independently rerun; failed verification stays failed; update user guide and relevant parity descriptions.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.
