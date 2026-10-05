---
id: FX-BE-162
type: Story
status: Backlog
---

# FX-BE-162: Safe desktop switching and reconnection

**Type:** Story
**Status:** Backlog
**Priority:** High
**Model:** gpt-6-astra
**Created:** 2026-10-05

**Delivery:** First release
**Feature:** [FX-BF-108](../../feature.md)
**Issue mirror:** [Local issue](../../../../../issues/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-162-safe-desktop-switching/issue.md)

## Impact

Safe desktop switching and reconnection enables the next delivery stage without losing existing desktop trust or confusing host ownership.

## Scope

lib/app/store.dart; lib/app/confirm_identity.dart; connection lifecycle tests. One active connection in the first release.

## Acceptance criteria

- Switch cancels reconnect/poll timers, unsubscribes and closes the old transport, resets host-scoped stores, cursors, command ledgers and biometric approval context, and bootstraps the selected desktop.
- A generation/connection guard covers every asynchronous read, bootstrap write, polling callback, resume handler, command result and reconnect callback. Late responses from A cannot mutate or persist B state.
- Selection persists explicitly; failed connection leaves the selected desktop visible with retry and switch actions. Never automatically fall back to a different desktop. Switching does not cancel desktop-side work or resend uncertain commands.

## Dependencies

FX-BE-161

## Tasks

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [TASK-422](tasks/task-422.md) | Implement guarded connection transitions | FX-BE-161 |
| [TASK-423](tasks/task-423.md) | Verify startup reconnect and stale-response isolation | TASK-422 |

## Validation

Run `flutter analyze` and `flutter test`, including focused new tests. For changed UI, run the feature visual matrix against the stage host and the real desktop. For native changes, build and verify both platforms. Apply desktop build/e2e checks only if desktop implementation changes.

## Close conditions

All listed tasks and acceptance criteria are complete. Link automated results and useful visual/device evidence; describe blockers instead of claiming unperformed checks. Deferred stories remain Backlog until their dependency gates and evidence are satisfied.

## Description


## Comments


