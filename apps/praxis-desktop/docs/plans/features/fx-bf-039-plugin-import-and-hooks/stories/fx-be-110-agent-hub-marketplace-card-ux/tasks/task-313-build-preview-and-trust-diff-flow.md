---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-313
title: "Build the preview-before-install and trust-diff flow"
status: Proposed
story: FX-BE-110
feature: FX-BF-039
updated: 2026-09-14
dependencies: [TASK-312, TASK-310]
---

# TASK-313: Build the preview-before-install and trust-diff flow

## Objective

Implement FX-BE-109/TASK-310's preview and trust-diff design: expanding a card
shows the agent's real instructions / skill's real body / MCP server's real target
before install, and updating an already-trusted plugin whose executable content
changed shows a real diff instead of a bare re-confirm.

## Implementation notes

- The preview reads directly from the resolved plugin content (TASK-307's
  resolution, TASK-308's conversion) — it must show the actual instructions body a
  user would be trusting, not a truncated description field.
- Model the diff view after the session inspector's own `ToolDiff` rendering per
  TASK-310's design note, so an old-script-vs-new-script or old-URL-vs-new-URL
  comparison feels native rather than a foreign dialog.
- This is the UI half of TASK-320's trust gate (FX-BE-114) — the diff must actually
  block the update from taking effect until the user acts on it, not just display
  informationally.

## Acceptance criteria

- Every content type (agent, skill, MCP server) has a working preview before
  install, matching TASK-310's mocked states.
- An update that changes a script or server URL shows a real diff and withholds the
  update until the user confirms.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` for the preview and trust-diff e2e coverage and
`npm run check-types` across workspaces.

## Description


## Dependencies



## Comments
