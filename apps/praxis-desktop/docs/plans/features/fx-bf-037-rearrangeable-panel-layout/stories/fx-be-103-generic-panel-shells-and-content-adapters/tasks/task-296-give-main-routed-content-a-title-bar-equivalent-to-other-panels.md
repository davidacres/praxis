---
**Status:** 📋 Proposed
**Created:** 2026-09-13T17:32:00.000Z
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-296
title: "Give main/routed content a title bar equivalent to other panels"
status: Proposed
story: FX-BE-103
feature: FX-BF-037
updated: 2026-09-13
dependencies: [TASK-294, TASK-295]
---

# TASK-296: Give main/routed content a title bar equivalent to other panels

## Objective

Resolve the architectural gap where center content (board/doc/session) has never had its own chrome: give it a `PanelShell` title bar (e.g. reflecting the current route/board/document name) so it is a self-contained panel like the others, movable to any region.

## Implementation notes

- Derive the title from existing route/navigation state; do not introduce a new naming concept.
- This is the highest-risk adapter since center content previously had no header — verify no existing spacing/scroll assumption in board/doc/session views breaks when a title bar is introduced above them.
- Preserve command-palette and other navigation entry points into this content unchanged.

## Acceptance criteria

- The behaviour is covered by deterministic unit or contract tests.
- Invalid, unsupported, stale and failure paths produce useful user-visible results.
- The implementation remains compatible with desktop and mobile renderers.
- Relevant documentation and plan references are updated.

## Verification

Run the board, document and session e2e specs to confirm layout/scroll is unaffected by the new title bar, plus a screenshot diff against the pre-change baseline.

## Description


## Dependencies



## Comments
