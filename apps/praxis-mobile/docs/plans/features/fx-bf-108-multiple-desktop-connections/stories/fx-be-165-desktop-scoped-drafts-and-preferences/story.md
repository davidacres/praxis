---
id: FX-BE-165
type: Story
status: Backlog
---

# FX-BE-165: Desktop-scoped drafts projects and appearance

**Type:** Story
**Status:** Backlog
**Priority:** High
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

**Delivery:** First release
**Feature:** [FX-BF-108](../../feature.md)
**Issue mirror:** [Local issue](../../../../../issues/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-165-desktop-scoped-drafts-and-preferences/issue.md)

## Impact

Desktop-scoped drafts projects and appearance enables the next delivery stage without losing existing desktop trust or confusing host ownership.

## Scope

lib/app/store.dart; lib/app/theme.dart; lib/screens/session_composer.dart; lib/screens/work_screen.dart; storage repository.

**Scope guard:** "Desktop-scoped" means mobile state keyed by the paired Praxis desktop host identity. It does not mean scoping Jira/GitHub/GitLab/folder/demo connections to desktop workspaces; stop if a generated plan redirects work there.

## Acceptance criteria

- Unsent text and attachment references belong to a desktop plus conversation/draft context. Switching restores the correct draft; never uploads attachments or sends a pending follow-up to another host. Document expiry/cleanup and unavailable attachment handling.
- Remember the selected project and cached theme independently for each host; missing/revoked project selection is explained and repaired using that host’s permitted projects.
- Apply the target cached appearance before bootstrap, or a neutral default when absent. Keep phone-only display size global; approval/permission state is re-read and re-authorised after switching.

## Dependencies

FX-BE-161, FX-BE-162

## Tasks

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [TASK-428](tasks/task-428.md) | Implement host-scoped preference and draft storage | FX-BE-161 |
| [TASK-429](tasks/task-429.md) | Restore scoped state and verify pending actions | TASK-428, FX-BE-162 |

## Validation

Run `flutter analyze` and `flutter test`, including focused new tests. For changed UI, run the feature visual matrix against the stage host and the real desktop. For native changes, build and verify both platforms. Apply desktop build/e2e checks only if desktop implementation changes.

## Close conditions

All listed tasks and acceptance criteria are complete. Link automated results and useful visual/device evidence; describe blockers instead of claiming unperformed checks. Deferred stories remain Backlog until their dependency gates and evidence are satisfied.

## Description


## Comments

