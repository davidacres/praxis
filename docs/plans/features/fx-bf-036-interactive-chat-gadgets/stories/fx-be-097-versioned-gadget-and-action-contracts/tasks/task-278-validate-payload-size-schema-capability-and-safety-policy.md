---
type: Task
id: TASK-278
title: "Validate payload size, schema, capability and safety policy"
status: planned
story: FX-BE-097
feature: FX-BF-036
updated: 2026-09-10
dependencies: [TASK-277]
---

# TASK-278: Validate payload size, schema, capability and safety policy

## Objective

Add deterministic validation rules for supported kinds, bounded data, action permissions, secret redaction and provider/workflow capability declarations.

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
