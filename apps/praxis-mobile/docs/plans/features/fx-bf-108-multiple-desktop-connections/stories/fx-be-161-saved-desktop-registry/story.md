---
id: FX-BE-161
type: Story
status: Backlog
---

# FX-BE-161: Saved desktop registry and migration

**Type:** Story
**Status:** Backlog
**Priority:** High
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

**Delivery:** First release
**Feature:** [FX-BF-108](../../feature.md)
**Issue mirror:** [Local issue](../../../../../issues/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-161-saved-desktop-registry/issue.md)

## Impact

Saved desktop registry and migration enables the next delivery stage without losing existing desktop trust or confusing host ownership.

## Scope

lib/app/connection.dart; new injectable registry repository and storage tests. Keep the phone identity global; registry metadata, routes and pinned host keys remain in secure storage.

## Acceptance criteria

- Versioned registry entries have a stable local entry ID, host ID, pinned public key, reported name, optional nickname, LAN/relay routes, selected project, cached appearance and last-used time. Active entry ID is separate.
- Migrate the single-host configuration and cached theme without changing the phone key or spending a new invitation. Write and read back the new registry before removing legacy values; migration is idempotent and recovers from interrupted writes.
- Validate entries independently, recover usable records, report storage failures, and avoid blind overwrite of a newer schema. Registry updates are serialised; forgetting one entry preserves all others.

## Dependencies

None

## Tasks

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [TASK-420](tasks/task-420.md) | Define registry and identity contracts | None |
| [TASK-421](tasks/task-421.md) | Implement recoverable secure-storage migration | TASK-420 |

## Validation

Run `flutter analyze` and `flutter test`, including focused new tests. For changed UI, run the feature visual matrix against the stage host and the real desktop. For native changes, build and verify both platforms. Apply desktop build/e2e checks only if desktop implementation changes.

## Close conditions

All listed tasks and acceptance criteria are complete. Link automated results and useful visual/device evidence; describe blockers instead of claiming unperformed checks. Deferred stories remain Backlog until their dependency gates and evidence are satisfied.

## Description


## Comments


