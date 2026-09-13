---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-303
title: "Add ARIA roles, labels and announcements for panel drag/drop"
status: Proposed
story: FX-BE-106
feature: FX-BF-037
updated: 2026-09-13
dependencies: [FX-BE-106]
---

# TASK-303: Add ARIA roles, labels and announcements for panel drag/drop

## Objective

Give the drag handle and drop zones appropriate ARIA roles/labels, and announce (via a live region) when a drag starts, which regions are valid drop targets, and when a move completes — so the feature is usable and legible via assistive technology, not just visually.

## Implementation notes

- The keyboard "Move panel to…" menu from TASK-299 is the primary accessible path; this task's live-region announcements support both that menu and an in-progress mouse drag.
- Use a single shared `aria-live="polite"` region rather than scattering multiple live regions across panels.
- Do not rely on colour alone for the drop-zone affordance (TASK-298) — ensure a non-colour cue (e.g. a border style change) accompanies it for contrast-insensitive users.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Manual screen-reader pass (VoiceOver) confirming announcements fire correctly, plus an e2e assertion on the live region's text content after a completed move.

## Description


## Dependencies



## Comments
