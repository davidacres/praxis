---
type: Story
id: FX-BE-086
title: "Deferred internet notifications"
status: backlog
feature: FX-BF-030
updated: 2026-09-09
dependencies: [FX-BE-079, FX-BE-085]
---

# FX-BE-086: Deferred internet notifications

**Priority:** Low

## Outcome

Add optional cloud push only after the local mobile release and authenticated internet connectivity are verified. This story does not block local execution or release.

## Dependencies

- FX-BE-079
- FX-BE-085

## Ordered tasks

- [TASK-232](tasks/task-232-add-opt-in-attention-notifications.md): Add opt-in attention notifications.

## Acceptance criteria

- Notifications use minimal opaque references and require current authorisation on opening.
- Local-only operation and foreground execution remain fully usable without cloud services or push permission.

## Verification

Use deterministic fixtures, then explicitly opted-in physical-device/service verification. Record revoked-device, stale-link and denied-permission results.

## Completion evidence

Not implemented.
