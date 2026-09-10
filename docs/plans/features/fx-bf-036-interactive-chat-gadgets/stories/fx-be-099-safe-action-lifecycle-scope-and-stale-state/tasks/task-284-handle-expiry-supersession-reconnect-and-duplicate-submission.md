---
type: Task
id: TASK-284
title: "Handle expiry, supersession, reconnect and duplicate submission"
status: planned
story: FX-BE-099
feature: FX-BF-036
updated: 2026-09-10
dependencies: [TASK-283]
---

# TASK-284: Handle expiry, supersession, reconnect and duplicate submission

## Objective

Define lifecycle transitions, replay rules, optimistic UI rollback and clear stale/disconnected messaging for desktop and mobile.

## Implementation notes

- Preserve the versioned browser-safe contract and existing host/session adapter boundary.
- Keep the local-first path usable without GenericSystem, Roleover, Azure or cloud connectivity.
- Record decisions and mutations through existing durable stores and append-only evidence where applicable.
- Do not allow provider or gadget payloads to execute arbitrary code or bypass policy.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run the focused package tests and the applicable desktop/mobile fixture or end-to-end journey. Capture visual or accessibility evidence for renderer changes.
