---
**Status:** ✅ Complete
**Created:** 2026-09-02T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-122
title: Add the non-terminal run count badge to the sidebar row and the workflowView route field.
status: complete
story: FX-BE-027
updated: 2026-09-02
dependencies: [FX-BF-013]
validation: [npm run check-types, npm run build:renderer, npm run test:desktop]
---
## Add the non-terminal run count badge to the sidebar row and the workflowView route field.
## Goal
See docs/plans/workflow-experience-design.md for the full spec.
## Done when
- `route.workflowView` field added, persisted in the durable route, and
  restored on relaunch.
- The non-terminal run count badge on the sidebar row is folded into FX-BE-028,
  which already rebuilds the sidebar-adjacent surfaces.
