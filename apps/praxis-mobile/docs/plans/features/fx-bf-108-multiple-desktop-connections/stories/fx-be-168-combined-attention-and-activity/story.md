---
id: FX-BE-168
type: Story
status: Backlog
---

# FX-BE-168: Combined attention and activity across desktops

**Type:** Story
**Status:** Backlog
**Priority:** Medium
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

**Delivery:** Later stage 2
**Feature:** [FX-BF-108](../../feature.md)
**Issue mirror:** [Local issue](../../../../../issues/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-168-combined-attention-and-activity/issue.md)

## Impact

Combined attention and activity across desktops enables the next delivery stage without losing existing desktop trust or confusing host ownership.

## Scope

lib/core/attention.dart; lib/screens/attention_screen.dart; lib/screens/activity_screen.dart; action routing and navigation.

**Scope guard:** "Across desktops" means the mobile client combines activity received from multiple paired Praxis desktop hosts. It does not combine Jira/GitHub/GitLab/folder/demo boards or change workspace connection membership.

## Acceptance criteria

- Offer Selected desktop and All desktops filters. Every combined item carries an immutable host identity and visible desktop label; use composite host/item keys and deterministic ordering.
- Opening an item selects its owning host/context and revalidates access. Decisions and retries route only to that host; unavailable hosts show scoped failures without substitute actions.
- Display last-updated/stale state for incomplete results; preserve filters and avoid duplicate items across replay. Visually verify mixed hosts, duplicate titles and offline sources.

## Dependencies

FX-BE-167

## Tasks

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [TASK-435](tasks/task-435.md) | Implement aggregate projections and host routing | FX-BE-167 |
| [TASK-436](tasks/task-436.md) | Verify aggregate actions and visual layouts | TASK-435 |

## Validation

Run `flutter analyze` and `flutter test`, including focused new tests. For changed UI, run the feature visual matrix against the stage host and the real desktop. For native changes, build and verify both platforms. Apply desktop build/e2e checks only if desktop implementation changes.

## Close conditions

All listed tasks and acceptance criteria are complete. Link automated results and useful visual/device evidence; describe blockers instead of claiming unperformed checks. Deferred stories remain Backlog until their dependency gates and evidence are satisfied.

## Description


## Comments

