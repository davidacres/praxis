---
id: FX-BE-166
type: Story
status: Backlog
---

# FX-BE-166: First release qualification and visual evidence

**Type:** Story
**Status:** Backlog
**Priority:** High
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

**Delivery:** First release
**Feature:** [FX-BF-108](../../feature.md)
**Issue mirror:** [Local issue](../../../../../issues/features/fx-bf-108-multiple-desktop-connections/stories/fx-be-166-first-release-qualification/issue.md)

## Impact

First release qualification and visual evidence enables the next delivery stage without losing existing desktop trust or confusing host ownership.

## Scope

test/protocol; test/app; test/ui; tool/stage_host.cjs; STATUS.md; docs/development.md. Two isolated hosts with distinct identities and temp write paths.

## Acceptance criteria

- Automated suite proves migration, two-host isolation, additive pairing, rename, forget, startup, reconnect, revocation, changed host key and races during streaming/approval. Both existing single-host flows and new multi-host flows remain green.
- Run two real desktop hosts and the production Flutter app end to end: pair both, switch, continue a conversation, approve only on its owning host, change project, background/resume, stop/restart a host and forget one. Stage hosts support repeatable automation but do not replace real desktop/device evidence.
- Visually inspect picker, add/rename/forget, sidebar, errors and approval context in light/dark and compact/large modes; use duplicate names and long names. Retain useful PNGs under .praxis/session-artifacts/ with captions and artifact gadgets at handoff.
- Qualify iOS and Android release builds and physical-device QR/network journeys; record exact devices/builds and outstanding blockers honestly. First release cannot close while required evidence is missing.

## Dependencies

FX-BE-162, FX-BE-163, FX-BE-164, FX-BE-165

## Tasks

| Task | Deliverable | Depends on |
| --- | --- | --- |
| [TASK-430](tasks/task-430.md) | Build two-host adversarial integration harness | FX-BE-161, FX-BE-162 |
| [TASK-431](tasks/task-431.md) | Capture end-to-end visual and device evidence | TASK-430, FX-BE-163, FX-BE-164, FX-BE-165 |
| [TASK-432](tasks/task-432.md) | Qualify release builds and document behaviour | TASK-431 |

## Validation

Run `flutter analyze` and `flutter test`, including focused new tests. For changed UI, run the feature visual matrix against the stage host and the real desktop. For native changes, build and verify both platforms. Apply desktop build/e2e checks only if desktop implementation changes.

## Close conditions

All listed tasks and acceptance criteria are complete. Link automated results and useful visual/device evidence; describe blockers instead of claiming unperformed checks. Deferred stories remain Backlog until their dependency gates and evidence are satisfied.

## Description


## Comments


