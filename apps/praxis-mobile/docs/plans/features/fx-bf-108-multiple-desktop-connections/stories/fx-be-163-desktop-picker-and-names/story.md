---
id: FX-BE-163
type: Story
status: Backlog
---

# FX-BE-163: Desktop picker and connection naming

**Type:** Story
**Status:** Backlog
**Priority:** High
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

**Delivery:** First release
**Feature:** [FX-BF-108](../../feature.md)
**Issue mirror:** [Local issue](../../../../../issues/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-163-desktop-picker-and-names/issue.md)

## Impact

Desktop picker and connection naming enables the next delivery stage without losing existing desktop trust or confusing host ownership.

## Scope

lib/screens: new Desktops screen; lib/ui/sidebar.dart; lib/main.dart. Reuse Pressable, ts() and existing theme/control primitives.

**Scope guard:** This story builds a mobile picker for paired Praxis desktop hosts. It is not the desktop app's Jira/GitHub/GitLab/folder/demo connection manager; stop if a generated plan redirects work to board connections.

## Acceptance criteria

- Picker is reachable from sidebar, offline/reconnecting screens and startup when no desktop is selected. Empty state offers Add desktop; rows show nickname or reported name, current selection and known connection state.
- Phone-local nicknames can be renamed or reset without replacing reported host names. Duplicate names are allowed and disambiguated by a non-secret host identifier/address.
- Show Connecting/Connected/Reconnecting/Unable to connect only when known; inactive saved entries are not labelled offline merely because they have no socket. Active desktop remains visible in work and approval context.
- Dark/light appearance, compact/large text, safe areas, keyboard and screen-reader labels work without clipped controls.

## Dependencies

FX-BE-161, FX-BE-162

## Tasks

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [TASK-424](tasks/task-424.md) | Build picker and naming controls | FX-BE-161 |
| [TASK-425](tasks/task-425.md) | Integrate picker and visually verify layouts | TASK-424, FX-BE-162 |

## Validation

Run `flutter analyze` and `flutter test`, including focused new tests. For changed UI, run the feature visual matrix against the stage host and the real desktop. For native changes, build and verify both platforms. Apply desktop build/e2e checks only if desktop implementation changes.

## Close conditions

All listed tasks and acceptance criteria are complete. Link automated results and useful visual/device evidence; describe blockers instead of claiming unperformed checks. Deferred stories remain Backlog until their dependency gates and evidence are satisfied.

## Description


## Comments

