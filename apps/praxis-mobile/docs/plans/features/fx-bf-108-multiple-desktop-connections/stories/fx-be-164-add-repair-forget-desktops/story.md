---
id: FX-BE-164
type: Story
status: Backlog
---

# FX-BE-164: Add repair and forget desktop pairings

**Type:** Story
**Status:** Backlog
**Priority:** High
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

**Delivery:** First release
**Feature:** [FX-BF-108](../../feature.md)
**Issue mirror:** [Local issue](../../../../../issues/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-164-add-repair-forget-desktops/issue.md)

## Impact

Add repair and forget desktop pairings enables the next delivery stage without losing existing desktop trust or confusing host ownership.

## Scope

lib/screens/connect_screen.dart; lib/app/discovery.dart; lib/core/invitation.dart; lib/app/connection.dart. Reuse existing protocol and desktop confirmation.

## Acceptance criteria

- Add desktop uses current QR/import/manual flows without replacing saved pairings. Pairing drafts stay separate until authenticated success; failed/cancelled/expired pairing leaves saved entries intact.
- An authenticated same-host/same-key pairing updates routes without duplicate entries or losing nicknames. Discovery can refresh an address but cannot replace a pinned key. Same host ID with a changed key requires explicit re-pairing and confirmation.
- Forget names the selected desktop, confirms local removal, deletes only its configuration/preferences/drafts and closes its socket if active. Explain local forgetting versus desktop-side revocation; other entries and phone identity survive.
- Revoked or refused access is scoped to its desktop, offers repair where appropriate, and does not silently try a different route to conceal an authentication failure.

## Dependencies

FX-BE-161, FX-BE-162, FX-BE-163

## Tasks

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [TASK-426](tasks/task-426.md) | Make pairing additive and identity-aware | FX-BE-161, FX-BE-162 |
| [TASK-427](tasks/task-427.md) | Add scoped repair and forget flows | TASK-426, FX-BE-163 |

## Validation

Run `flutter analyze` and `flutter test`, including focused new tests. For changed UI, run the feature visual matrix against the stage host and the real desktop. For native changes, build and verify both platforms. Apply desktop build/e2e checks only if desktop implementation changes.

## Close conditions

All listed tasks and acceptance criteria are complete. Link automated results and useful visual/device evidence; describe blockers instead of claiming unperformed checks. Deferred stories remain Backlog until their dependency gates and evidence are satisfied.

## Description


## Comments


