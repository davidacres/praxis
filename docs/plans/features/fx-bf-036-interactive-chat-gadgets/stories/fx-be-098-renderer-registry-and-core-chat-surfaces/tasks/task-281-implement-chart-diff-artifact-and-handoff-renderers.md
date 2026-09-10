---
type: Task
id: TASK-281
title: "Implement chart, diff, artifact and handoff renderers"
status: planned
story: FX-BE-098
feature: FX-BF-036
updated: 2026-09-10
dependencies: [TASK-280]
---

# TASK-281: Implement chart, diff, artifact and handoff renderers

## Objective

Add bounded visual/data renderers and links into existing changes, artifacts, sessions and handoff inspection surfaces.

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
