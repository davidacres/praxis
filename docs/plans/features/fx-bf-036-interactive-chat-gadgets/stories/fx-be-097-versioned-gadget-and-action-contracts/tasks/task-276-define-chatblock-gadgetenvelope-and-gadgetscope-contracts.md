---
**Status:** 📋 Proposed
**Created:** 2026-09-10T10:48:08.262Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-276
title: "Define ChatBlock, GadgetEnvelope and GadgetScope contracts"
status: planned
story: FX-BE-097
feature: FX-BF-036
updated: 2026-09-10
dependencies: [FX-BE-097]
---

# TASK-276: Define ChatBlock, GadgetEnvelope and GadgetScope contracts

## Objective

Define the discriminated union for Markdown, choice, confirmation, form, table, chart, progress, diff, artifact and handoff blocks; include stable IDs, versions and scope.

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

## Description


## Dependencies



## Comments


