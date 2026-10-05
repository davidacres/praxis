---
id: FX-BE-167
type: Story
status: Backlog
---

# FX-BE-167: Concurrent desktop observation and lifecycle

**Type:** Story
**Status:** Backlog
**Priority:** Medium
**Model:** gpt-6-astra
**Created:** 2026-10-05

**Delivery:** Later stage 2
**Feature:** [FX-BF-108](../../feature.md)
**Issue mirror:** [Local issue](../../../../../issues/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-167-concurrent-desktop-observation/issue.md)

## Impact

Concurrent desktop observation and lifecycle enables the next delivery stage without losing existing desktop trust or confusing host ownership.

## Scope

lib/app/store.dart split into per-host contexts; lib/app/connection.dart; lifecycle/polling supervisor. Foreground concurrent observation; explicit foreground target for actions.

## Acceptance criteria

- Allow several saved desktops to be observed while one is selected for interaction. Each context owns its transport, event cursor, retry budget, access grant, cache and commands. One host failing never clears others.
- Define and test connection cap, opt-in policy, polling limits, battery/latency budget and foreground/background lifecycle before enabling concurrency. Do not promise persistent background sockets on iOS/Android.
- Forgotten/revoked hosts stop immediately; switching does not restart unaffected observers. Approvals revalidate the owning host and current access, independent of the selected screen.
- Use relay routes only when configured and tested; local-only operation remains independent of cloud availability.

## Dependencies

FX-BE-166

## Tasks

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [TASK-433](tasks/task-433.md) | Design per-host contexts and resource budgets | FX-BE-166 |
| [TASK-434](tasks/task-434.md) | Implement and qualify concurrent observation | TASK-433 |

## Validation

Run `flutter analyze` and `flutter test`, including focused new tests. For changed UI, run the feature visual matrix against the stage host and the real desktop. For native changes, build and verify both platforms. Apply desktop build/e2e checks only if desktop implementation changes.

## Close conditions

All listed tasks and acceptance criteria are complete. Link automated results and useful visual/device evidence; describe blockers instead of claiming unperformed checks. Deferred stories remain Backlog until their dependency gates and evidence are satisfied.

## Description


## Comments


