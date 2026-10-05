---
id: FX-BE-169
type: Story
status: Backlog
---

# FX-BE-169: Host-scoped notifications and deep links

**Type:** Story
**Status:** Backlog
**Priority:** Low
**Model:** gpt-6-astra
**Created:** 2026-10-05

**Delivery:** Later stage 3
**Feature:** [FX-BF-108](../../feature.md)
**Issue mirror:** [Local issue](../../../../../issues/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-169-multi-desktop-notifications/issue.md)

## Impact

Host-scoped notifications and deep links enables the next delivery stage without losing existing desktop trust or confusing host ownership.

## Scope

Platform notification adapters and deep-link routing; existing FX-BE-086 owns delivery infrastructure. Companion desktop/relay plans only if independent new deliverables are identified.

## Acceptance criteria

- Opt in globally and per desktop, with permission denial and mute controls. Notification IDs, deduplication, click targets and cancellation include host identity; lock-screen previews avoid sensitive content by default.
- A notification opens the correct desktop and request after fresh access checks. Forgotten/revoked/unreachable hosts, expired requests and duplicate names have clear outcomes; no direct background approval.
- Reuse the notification delivery owner FX-BE-086 rather than building a second push/relay system. Qualify real physical iOS/Android delivery, background/cold-start routing, mute/forget cleanup and visible host attribution.
- A production cloud service or OS permission change needs its own concrete rollout gate; local multi-desktop use remains fully available without notifications.

## Dependencies

FX-BE-168, FX-BE-086

## Tasks

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [TASK-437](tasks/task-437.md) | Specify notification ownership and deep-link contract | FX-BE-168, FX-BE-086 |
| [TASK-438](tasks/task-438.md) | Implement per-host preferences and safe click routing | TASK-437 |
| [TASK-439](tasks/task-439.md) | Qualify notifications and final feature closure | TASK-438 |

## Validation

Run `flutter analyze` and `flutter test`, including focused new tests. For changed UI, run the feature visual matrix against the stage host and the real desktop. For native changes, build and verify both platforms. Apply desktop build/e2e checks only if desktop implementation changes.

## Close conditions

All listed tasks and acceptance criteria are complete. Link automated results and useful visual/device evidence; describe blockers instead of claiming unperformed checks. Deferred stories remain Backlog until their dependency gates and evidence are satisfied.

## Description


## Comments


